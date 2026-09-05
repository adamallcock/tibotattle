---
title: macOS Intel and Universal 2 feasibility for issue 93
date: 2026-08-31
type: research
status: investigated
---

# macOS Intel and Universal 2 feasibility

**Recommendation: pursue Intel support upstream in the existing native app, with a thin Intel development candidate first and one Universal 2 release as the intended distribution model.** The investigation found no fundamental Apple Silicon requirement in the current native application. Actual cross-compilation and translated runtime probes support that conclusion. The work is a moderate build, credential-policy, integrity, and qualification project; it is not a one-flag release change.

This is a point-in-time feasibility and scope record for [issue #93](https://github.com/adamallcock/tibotattle/issues/93), verified on **2026-08-31**. It is not approval to change the support contract, sign or distribute a candidate, deploy the updater guard, or publish a release. Product source was not modified.

## Baseline and scope

| Evidence | Exact baseline |
|---|---|
| Issue | Open enhancement, created 2026-08-31; requests Intel macOS, preferably Universal 2; reporter offers real Intel hardware; no comments when read |
| Current upstream source | [3d9055fc8e58c84f8ba71feb5deb58b52c532138](https://github.com/adamallcock/tibotattle/commit/3d9055fc8e58c84f8ba71feb5deb58b52c532138), package version 0.1.17 |
| Task checkout | Older detached commit 4cb5c48955c2a49861927ef51d6738eab0ef7763; left unchanged |
| Investigation source | An isolated, unmodified archive of the current upstream commit; current-source citations below refer to that commit |
| Published stable release | [0.1.16](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.16), published 2026-08-21; API lists one macOS DMG, TiboTattle-0.1.16-macOS-arm64.dmg, 49,341,389 bytes |
| Published install route | First-party Homebrew cask at [17fe9111462f00ec053dc180968209a910ded24e](https://github.com/adamallcock/homebrew-tap/blob/17fe9111462f00ec053dc180968209a910ded24e/Casks/tibotattle.rb), version 0.1.16; explicitly arm64 and Sonoma |
| Existing support floor | macOS 14 or later on Apple silicon; [Intel is explicitly unclaimed](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/docs/reference/platform-support.md#macos) |
| Local probe environment | Apple Silicon host, macOS 26.6.2, Node 26.2.0, Swift 6.3.3, macOS SDK 26.5; Intel execution used Rosetta |

The published asset was identified through live release metadata, not downloaded and requalified. The current-source and local-probe claims do not describe the bytes in the published 0.1.16 DMG.

Keep macOS 14 as the initial Intel floor. Intel support would not automatically cover older Macs unable to run Sonoma. Lowering the OS floor, supporting patched operating systems, rewriting the shell in Electron, and porting the standalone local-review CLI are separate decisions.

## What was demonstrated locally

All probes used current source, public dependencies, synthetic data, and disposable output. No actual Keychain secrets, user transcripts, installed application state, Login Items, signing credentials, or hosted contribution endpoints were used.

| Probe | Observed result | What it does not prove |
|---|---|---|
| Swift Intel compile without Sparkle | All 11 Swift files compiled successfully; Mach-O x86_64, deployment target 14.0 | Packaging, Intel hardware, or release trust |
| Optimized Swift compile with Sparkle | Both arm64 and x86_64 compiled with the existing release optimization flags and pinned framework | Accepted notarization or actual updater operation |
| Pinned Sparkle inspection | Repository framework-tree validation passed for 2.9.3; all five bundled Mach-O subjects contain x86_64 and arm64 | Qualification of a newly signed app |
| Universal Swift assembly | Both compiled launcher slices merged successfully; each slice ran the existing fake Login Item contract smoke | Real ServiceManagement, native visual QA, or real Keychain behavior |
| Official Intel Node | Verified the 26.2.0 Darwin x64 archive checksum; executable reports x64 and a 13.5 deployment target; linked non-Node dependencies are system libraries | Native Intel performance |
| Node SQLite and workers | x64 Node and its worker thread used SQLite 3.53.1; arm64 and x64 read/write the same synthetic WAL database, preserve a large exact integer, and pass integrity_check | Compatibility of arbitrary real app databases or schema migrations |
| Universal Node assembly | Existing local pinned arm64 Node plus verified official x64 Node merged; both architecture selections executed successfully | A reproducible, signed release runtime |
| Credential-policy reproduction | Both current selectors reject darwin/x64 before invoking an injected backend; arm64 accepts the same injected factories | A fix, or physical Keychain access |
| Current Mach-O canonicalizers | Both exact source implementations accept the thin probe headers and reject universal launcher/Node headers | Full candidate/signature verification |
| Focused accounting/index tests | Correct-source-directory runs on arm64 and x64: 175 passed, 0 failed, 0 skipped on each | A complete Intel release gate |

The focused suite comprised the unchanged cost-ledger, local-unified-index, and replay-safe-accounting-cache tests. An initial setup attempt lacked runcost and did not execute the tests successfully. After dependency setup, an earlier x64 run had **174 passed and 1 failed**: “an abort during incremental close cannot publish its finalized stage.” The exact test then passed in isolation on both arm64 and x64. Full runs from the source snapshot subsequently passed all 175 on each architecture (arm64 about 6.9 seconds; translated x64 about 11.7 seconds). These durations are test receipts, not a hardware-performance comparison. The earlier failure remains recorded rather than replaced with a green-only account.

Inspection suggests a timing-sensitive test observer: it polls a staging SQLite database synchronously with a two-second deadline, while the database reader can wait five seconds and staging uses exclusive locks. It also checks terminal status without identifying the newly staged generation. The observed failure is not evidence that canceled data was published, but the test seam needs investigation before treating repeated passes as a robust qualification gate. No assertion or timeout was changed. [Test observer](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/test/local-unified-index.test.js#L368), [SQLite opener](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/src/local-unified-index.js#L1575).

Probe files and full logs remain in the ignored task-local directory `.release-build/issue93-research/`. These are investigation outputs, not distributable apps or permanent release receipts.

## Architecture and dependency findings

### The native app is portable; its current build policy is not

The Swift shell uses ordinary AppKit, Foundation, WebKit, ServiceManagement, UserNotifications, Security, and Darwin APIs. No architecture-specific intrinsics or Swift arch conditionals were found. Both architectures compiled at the existing macOS 14 deployment target.

The builder deliberately requires an arm64 host, targets arm64, validates an arm64 executable, copies its own host Node executable, and strips every bundled Sparkle executable down to arm64. These are explicit implementation and qualification constraints. [Pins](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L94), [host gate](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L1875), [compiler and staging](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L1987).

Use an explicit architecture mapping: Node calls Intel **x64**; Apple target triples and Mach-O tools call it **x86_64**; a Universal 2 artifact must contain the exact set **arm64 + x86_64**. Host architecture and target architecture must become separate build inputs.

### Current native packaging does not need an Intel Keytar port

This is a significant difference from the older task checkout and released-code lineage. Current main has retired Keytar from new native bundles. Swift owns the closed Keychain broker protocol, and the packaged dependency graph excludes the native addon. The collected application graph contained 212 source files; the declared external dependencies are workspace packages, Ajv, and runcost/browser.

Keytar references retained for older Preview validation are compatibility checks, not instructions to bundle it again. The standalone CLI/local-review and some fallback paths still have different platform constraints and remain outside this native-app scope. [Native lifecycle](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/apps/macos/README.md#native-macos-app), [current dependency boundary](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L254), [legacy-only inventory](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L144).

Two application-level checks still reject x64 **before** using the injected native broker:

| Current check | Consequence | Required scope |
|---|---|---|
| [Production participant identity](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/src/application/production-participant-identity.js#L42) | Export/participant identity selection fails | Admit the qualified macOS broker on the two approved CPU architectures while preserving capability checks and closed failure behavior |
| [Account observation](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/src/account-observation-production.js#L66) | Account-scoped collection cannot obtain its credential | Add x64 broker-backed acceptance and attribution tests |

The second failure can be caught and converted into an unavailable account-observation loader. A dashboard that opens and shows totals could therefore conceal unattributed evidence. Qualification must assert attribution and identity continuity, not just visible activity. [Fallback boundary](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/src/local-companion-refresh.js#L1038).

Do not solve these failures with plaintext credential storage, environment-secret fallbacks, relaxed capability validation, or restoration of Keytar.

### Node, SQLite, and Sparkle are available for Intel

Official Node 26.2.0 provides Darwin x64 builds; its pinned documentation supports macOS 13.5 and later for both architectures. The downloaded x64 tar.xz matched SHA-256 **50e3fb7cda816f0ab8929551516530669d1c0449a3f6a8a044be82a57cc642a4**. TiboTattle's SQLite is built into Node rather than a separate addon needing a port. [Official release directory](https://nodejs.org/download/release/v26.2.0/), [checksums](https://nodejs.org/download/release/v26.2.0/SHASUMS256.txt), [versioned build requirements](https://github.com/nodejs/node/blob/v26.2.0/BUILDING.md), [SQLite import](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/src/local-unified-index.js#L18).

The verified Sparkle 2.9.3 framework already includes both slices in its framework binary, Installer and Downloader XPCs, Autoupdate helper, and Updater app. Preserve those slices for Universal 2. The current builder intentionally discards Intel slices. [Pinned upstream release](https://github.com/sparkle-project/Sparkle/releases/tag/2.9.3), [current thinning loop](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L2054).

### Provider installation is an acceptance condition

Official Codex desktop release notes announced Intel support on 2026-04-16, and the current CLI 0.151.0 release contains Darwin x86_64 assets. An Apple-Silicon-only Codex prerequisite is therefore not a valid reason to reject this issue. The Intel desktop artifact itself was not downloaded or tested here. [Official desktop changelog](https://learn.chatgpt.com/docs/changelog#other-features), [official CLI release](https://github.com/openai/codex/releases/tag/rust-v0.151.0).

There is a conditional discovery gap for CLI-only installations. TiboTattle tries CODEX_BIN, the ChatGPT and Codex application bundles, then bare codex. Its native companion launch environment omits CODEX_BIN and exposes only system PATH directories, excluding typical Homebrew/npm locations. Verify the actual Intel tester setup. Desktop-bundled discovery may work unchanged; CLI-only live quota requires a reviewed explicit discovery/selection mechanism, not indiscriminate PATH forwarding. Local log ingestion is a separate capability. [Resolver](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/src/providers/codex/app-server.js#L44), [sealed native environment](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/apps/macos/UsageMonitorApp.swift#L2024).

## Distribution choice

| Option | Advantages | Costs and limitations | Assessment |
|---|---|---|---|
| Thin x86_64 development candidate | Smallest useful physical-Intel checkpoint; simpler binary inspection | Still needs broker policy changes, target Node, correct Sparkle slices, and explicit unsupported/experimental status | Recommended first stage |
| One Universal 2 native release | Same application, state, identity, DMG, and feed per channel; fits the existing single-artifact model | Larger download/install footprint; universal payload verification and both-CPU QA required | Recommended destination |
| Two public thin releases | Smaller per-device downloads; simpler per-file Mach-O parsing | Architecture-aware download/cask selection and separate feeds or a broader updater policy; two final-artifact qualification paths | Viable fallback if size or universal integrity proves unacceptable |
| Intel fork or shell rewrite | Independent experimentation possible | Duplicate security, accounting, release, and maintenance work without a demonstrated architectural need | Not justified by present evidence |

For Universal 2, prefer one universal Node executable at the existing runtime/bin/node location, subject to integrity and release qualification. Both companion startup and the reset helper already use that path. A dual-runtime directory/selector remains an alternative if universal Node proves unsuitable, but it adds more selection, inventory, signing, and subprocess cases. Apple's documented universal-binary approach supports combining architecture slices; this investigation verified basic execution of the resulting Node and launcher binaries. [Apple guidance](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary).

Measured executable sizes:

| Subject | arm64 | x86_64 | Combined |
|---|---:|---:|---:|
| Node 26.2.0 | 144,191,552 B | 145,949,200 B | 290,156,608 B |
| Optimized Swift launcher with Sparkle linkage | 2,002,280 B | 2,048,896 B | 4,066,664 B |

Node alone grows from about **137.5 MiB to 276.7 MiB**, adding about **139.2 MiB**. This is disk footprint, not a measured doubling of working memory. The complete universal bundle, compressed DMG, update download, and peak build memory were not measured. Preserve and test the existing 512 MiB bundle/artifact limits; do not raise them preemptively.

## Critical implementation contracts

### Verify every architecture before signing

The current builder and release verifier each contain a thin-only Mach-O canonicalizer. They intentionally remove only signature-dependent representation changes before comparing reviewed payloads. Both reject the universal binaries produced by this investigation. [Builder implementation](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-macos-app.js#L2497), [release implementation](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/macos-release-core.js#L604).

A universal implementation must:

1. Validate the exact architecture set for the launcher, Node, and all five Sparkle executables.
2. Bind both Node input versions/hashes, target architecture set, compiler/SDK inputs, and framework provenance into build evidence.
3. Validate all slices and hash every slice's executable content; never inspect only the build host's slice.
4. Reject malformed, duplicate, missing, unexpected, overlapping, out-of-bounds, or truncated slice structures.
5. Prove that legitimate signature replacement preserves normalized identity, while content tampering in either slice is detected.
6. Preserve verification of existing thin releases and the exact, narrowly scoped legacy Preview/dogfood compatibility cases.
7. Complete lipo assembly before candidate inventory, review, reproduction, signing, and notarization.

A small shared verifier may remove the present duplication, but its tests need independent signed/tampered fixtures. Do not turn the current normalizer into a permissive “accept fat files” check. The finalizer rebuilds and compares source and payload digests; patching a completed candidate with lipo would violate that contract. [Reproduction gate](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/macos-release-core.js#L3070).

Keep the Developer ID identity, bundle IDs, entitlements, Keychain services, app-state roots, callback schemes, and channel/key separation unchanged. Apple's nested-code signing order still applies; the distributed universal result must obtain its own complete validation and notarization receipt. [Apple signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/_index.html), [notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

### Migrate update acceptance before publishing a universal feed

Current stable/dogfood policy is one item, one full DMG, no deltas, and no retained history. Both the local signed-feed validator and Worker guard require the literal arm64 hardwareRequirements element. The official generator stages one DMG and preserves Sparkle's signed XML bytes. [Policy](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/config/sparkle-appcast-policy.js#L10), [local pattern](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/sparkle-signed-feed-validation.js#L37), [Worker pattern](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/apps/worker/src/sparkle-appcast-guard.ts#L550).

Sparkle 2.9.3 infers that arm64 requirement from the **main app executable**, not the complete bundle. Its source indicates the requirement is omitted for a main executable containing an Intel slice; the actual official generator output for the final candidate still needs to be captured. A universal shell with arm64-only Node could otherwise advertise false Intel compatibility. Sparkle's arm64 tag is not a general two-artifact routing mechanism. [Generator detection](https://github.com/sparkle-project/Sparkle/blob/2.9.3/generate_appcast/ArchiveItem.swift#L263), [hardware resolver](https://github.com/sparkle-project/Sparkle/blob/2.9.3/Sparkle/SPUAppcastItemStateResolver.m#L127).

The migration must preserve byte-level feed signatures, artifact signatures, URL allowlists, size limits, channel separation, and atomic monotonic publication. Change the Worker parser and character-identical local mirror together, with legacy-arm64 and universal-feed fixtures plus tamper/refusal cases. Verify the final artifact's architecture set before trusting the generated compatibility claim. Deploy and read back compatible guard acceptance before publishing the first new feed. Never hand-edit XML after it is signed.

Allocate a new release/bundle version; do not replace existing release bytes in place. Rehearse an installed arm64 release updating to the universal candidate. On Intel, rehearse two Intel-capable versions: the existing arm64-only stable DMG cannot serve as its rollback artifact. Architecture compatibility alone does not establish recoverability. Feed-based recovery needs a higher-bundle-version recovery release because the guard rejects downgrades. Manual recovery needs a compatible Intel-capable artifact and, when schemas require it, a separately authorized restoration of its matching state backup; never launch an older writer against newer state or destructively downgrade the only database. [State-recovery boundary](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/docs/runbooks/macos-stable-release-runbook.md#L124).

### Carry architecture evidence through downloads and Homebrew

The canonical filename, release/package defaults, and public release-site generator assume arm64. The public-site generator explicitly rejects Intel/universal metadata and selects an arm64 artifact. By contrast, the install card already understands arm64 plus x86_64 and can display Apple silicon and Intel; a new download UI design is unnecessary. [Release filename](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/config/release-manifest.js#L24), [site validation](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-public-release-site.js#L448), [install card](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/apps/web/public/install-cta.js#L91).

The common release-evidence schema already permits an architecture token such as universal2. The native finalizer receipt does not currently state the measured architecture set. Bind actual verified compatibility to artifact evidence and use it throughout publication; an architecture-shaped filename is not proof. [Common evidence vocabulary](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/config/release-evidence.js#L27), [native final receipt](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/macos-release-core.js#L3174).

The separate Homebrew tap needs coordinated work: remove its arm64-only admission for a qualified universal artifact, update URL/checksum and exact asset selection, extend workflow tests, and verify installation on both CPU families. Its updater currently looks specifically for the arm64 DMG and skips work when the version is unchanged, another reason to use a new version. Preserve Sonoma, auto_updates, uninstall, and narrowly scoped zap behavior. [Cask](https://github.com/adamallcock/homebrew-tap/blob/17fe9111462f00ec053dc180968209a910ded24e/Casks/tibotattle.rb), [update automation](https://github.com/adamallcock/homebrew-tap/blob/17fe9111462f00ec053dc180968209a910ded24e/.github/workflows/update-tibotattle.yml), [tap CI](https://github.com/adamallcock/homebrew-tap/blob/17fe9111462f00ec053dc180968209a910ded24e/.github/workflows/ci.yml).

## Proposed work packages and exit criteria

Estimates are engineering judgment, not measured implementation time or a delivery commitment. They assume the existing architecture, available signing operations, and an Intel tester who can return timely results. Work overlaps; totals are not the sum of every maximum.

| Work package | Principal ownership | Exit criterion | Rough effort |
|---|---|---|---|
| 1. Explicit target and thin Intel candidate | Native builder, Node input selection, two credential selectors, focused tests | Complete isolated x86_64 development app with correct broker composition and no relaxed security gates | 1–2 engineering days |
| 2. Universal binary integrity | Shared build/release payload verification, per-slice tests, source/input evidence | Both architectures inventoried; deterministic reproduction; legitimate re-signing accepted; either-slice tampering rejected; legacy thin validation retained | 2–3 days |
| 3. Update and artifact plumbing | Appcast generator/validator, Worker guard, manifest/naming, public-site generator, Homebrew tap | Legacy and universal feed contracts verified; architecture evidence reaches the actual install routes; deployment order documented | 1–2 days |
| 4. Automated and physical qualification | Test lanes, native Intel/arm64 CI, real Intel tester, resource evidence | Non-skipped target suites plus lifecycle, identity, attribution, performance and update receipts for exact artifacts | 2–3 days, plus tester turnaround |
| 5. Authorized release execution | Existing release owner/runbooks | Signed/notarized artifacts, guard, feed, immutable release, tap, website and support statements independently verified | Owner-dependent; outside this research authorization |

**Planning range: roughly 1–2 focused engineering weeks for a release-ready Universal 2 path, plus external testing and release turnaround.** A thin experimental app is the earlier checkpoint. The main schedule uncertainty is integrity/update qualification and physical-machine findings, not Swift compilation.

Scope the first contributor change narrowly: target parameterization, verified runtime staging, broker-backed x64 admission, and tests. Separate the universal verifier and hosted release migration into reviewable changes. A contributor does not need release-signing secrets to help with source, tests, or local hardware qualification.

Do not automatically fold in a Node-version change, Sparkle upgrade, new telemetry/schema, Electron port, generic credential redesign, macOS-floor reduction, public CLI support, or data migration. Any required adjacent security maintenance should be identified and reviewed separately.

## Qualification and support gates

| Gate | Minimum evidence before a support claim |
|---|---|
| Hardware and OS | Real Intel on macOS 14 at the claimed floor, plus a later supported Intel macOS version where practical; native Apple Silicon regression on the same final universal bytes |
| Complete binary architecture | Exact arm64+x86_64 set for the launcher, Node, and every Sparkle subject; no host-only runtime dependency; min-OS and linked-library inspection |
| Local-only operation | Offline first launch, synthetic and consenting tester-owned log ingestion, indexing, cancel/retry, last-good-state retention, replay/deduplication, and explicit gap handling |
| Credential and attribution | Actual Swift Keychain broker reads/creates, locked/denied behavior, unchanged services and identity, account switching, attribution, optional contribution preparation without unauthorized upload |
| Provider availability | Intel Codex desktop-bundled executable works, or an explicitly supported CLI-only configuration; missing executable remains actionable and does not masquerade as available quota |
| Native lifecycle | Menu bar/popover, WebKit dashboard, settings, notifications, first run, login item approval/recovery, restart, sleep/wake, quit and no orphan companion |
| Performance | Cold history, incremental refresh, peak memory, UI responsiveness, worker limits and watchdogs on Intel; no extrapolation from Rosetta or arm64 R7 receipts |
| Data continuity | Existing-state upgrade and migration against copies; no architecture-driven schema reset; unknown/newer schemas remain protected |
| Trust and replacement | Quarantined download, Developer ID verification, hardened runtime, notarization/stapling, clean launch, arm64-to-universal upgrade, Intel-to-Intel update, and rehearsed higher-version feed recovery or compatible manual artifact/state restoration |
| Distribution | New immutable DMG/checksum/evidence, compatible signed feed and Worker readback, matching Homebrew/website metadata, and accurate support documentation |

Current artifact tests and smoke-lane guards explicitly restrict execution to arm64/Node 26.2.0. Simply removing a skip can still produce misleading evidence. Record actual process architecture and expected test counts, and fail when the intended native gate does not run. The inspected current application workflow tree has no standing native macOS build job. GitHub currently offers standard macos-15-intel and macos-26-intel runners; public-repository standard jobs are available without buying larger runners. No CI job was triggered here. [Existing artifact gate](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/test/macos-app-bundle.test.js#L242), [lane guard](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/test-lanes.mjs#L374), [GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

R7 watchdog/runtime restrictions and the arm64-only native network-audit build also need an explicit Intel qualification decision. Do not regenerate protected receipts, relax resource ceilings, or claim physical support as a side effect of source testing. [R7 operational authority](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/docs/runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md), [audit build target](https://github.com/adamallcock/tibotattle/blob/3d9055fc8e58c84f8ba71feb5deb58b52c532138/scripts/build-native-network-audit.js#L45).

Before the first hardware handoff, collect only the tester's Mac model, macOS version, available memory, Codex install type, and ability to test repeat upgrades. Do not request raw sessions, account identifiers, credentials, or unredacted diagnostics. The reporter's offer is valuable, but it is not yet a booked test environment or an ongoing maintenance commitment.

## Maintenance horizon and remaining uncertainty

Apple states that Tahoe is the final macOS release for Intel. Node's current v26.x policy lists Intel as Tier 2 until early 2028, then experimental/untested as its test-provider coverage ends. These facts favor a bounded, periodically reviewed support commitment rather than an indefinite promise. Neither prevents the current macOS 14+ implementation. Pin and qualify a toolchain that still emits both slices; do not assume future default SDKs preserve that capability. [Apple WWDC26](https://developer.apple.com/videos/play/wwdc2026/112/), [current Node 26 support policy](https://github.com/nodejs/node/blob/v26.x/BUILDING.md#platform-list).

GitHub currently provides macOS 26 Intel runners despite an older announcement predicting the end of Intel images after macOS 15. Treat an exact retirement date as uncertain and recheck during implementation, rather than basing the plan on the older announcement alone. [2026 availability announcement](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/).

Sparkle's pinned 2.9.3 is behind upstream 2.9.6, which includes later security fixes. Review applicability before a new release. No exploitability finding or Intel-specific defect was established in this investigation, and the dependency was not upgraded. [Upstream release notes](https://github.com/sparkle-project/Sparkle/releases/tag/2.9.6).

The remaining material unknowns are real Intel Keychain/lifecycle behavior, the supported tester OS floor, older-hardware performance, final universal bundle/download size, reproducible signing-normalized payloads, official generated feed output, and full signed update/rollback behavior. These are concrete qualification tasks, not reasons to fork the product.

## Suggested issue response, not posted

Intel support looks feasible in the existing native app. We have cross-compiled the current Swift source for x86_64 and verified that the pinned Node and Sparkle dependencies can supply Intel-compatible binaries. The current arm64-only restriction also exists in credential-selection, packaging, integrity verification, and updater policy, so it needs a coordinated change rather than only a second executable slice.

The preferred direction is a thin Intel development candidate for hardware testing, followed by a Universal 2 release if both architectures pass the existing trust and lifecycle gates. We would initially retain macOS 14 as the minimum. Your offer to test on real Intel hardware would help with that qualification; no Intel release or delivery date is committed yet.
