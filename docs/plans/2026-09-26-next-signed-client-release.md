---
title: Next signed client release after Codex CLI discovery repair
date: 2026-09-26
type: plan
status: in-progress
---

# Next signed client release

## Boundary and current evidence

The 2026-09-26 `codex/codex-cli-discovery` branch contains a source-only repair
for locating the Codex CLI inside current and legacy ChatGPT/Codex app bundles,
plus path-free location diagnostics. The selected successor is 0.1.25 with Mac
stable bundle allocation `1033`. The source is not yet frozen and has no
packaged, signed, installed, or published successor artifact. The installed
0.1.24 client is unaffected until a successor is built and installed. The
user authorized preparation of signed 0.1.25 successors for the four direct
targets; this does not authorize public release or updater publication.

The active CLI path selectors are the provider resolver and contract-drift
inspector. Their source contract ledger now describes both layouts. A separate
CLI-only installation on a restricted GUI PATH may still require an explicit
`CODEX_BIN` setting; no broad filesystem search is proposed.

Source checks completed on 2026-09-26: preflight, architecture, documentation,
release notes, contract drift, focused provider/browser/local/i18n checks, and
the release trust suite passed. The Worker product lane passed 160 test files
and 2,002 tests; its final deployment dry run refused the still-dirty source
tree as designed. The first full root suite found stale model/catalog inventory
assertions, which are repaired in this candidate; native sandbox and process
tests passed when rerun with host permissions. Retained R7 receipts are stale
because their workload closure includes the changed source and package files.
The maintained R7 runbook requires separate owner authorization before its
private-history, dual-runtime regeneration. No artifact should be treated as
release-qualified while that evidence gate remains open.

CodexBar's [documented app default](https://github.com/steipete/CodexBar/blob/e0286a895055e60ddaefa6a5f176f246aa2f05e4/docs/codex.md#L199-L215)
tries a direct OAuth usage request before its CLI RPC strategy. That is a
separate access contract, including credential ownership and token-expiry
recovery. It may be evaluated for later resilience, but is not a prerequisite
for qualifying this bundle-discovery repair.

## Release scope decision

Prepare Mac arm64/x64 and Windows x64 signed candidates plus the Linux x64
AppImage, which has no native signing scheme. Bind all four to one frozen
source revision, version, and build number `2026092601`. The public lane remains a later decision
under the cross-platform publication runbook; candidate artifacts do not
establish public platform support or updater availability.

## Source and artifact gates

1. Review and land the CLI repair, independent quota freshness, and bounded
   terminal refresh presentation, including provider, local companion,
   browser, contract-drift, architecture, and documentation checks.
2. Update the 0.1.25 root and workspace package versions, telemetry
   compatibility and generated artifacts, changelog, and release notes. Use
   the reviewed Mac bundle allocation `1033`, preserving the existing 0.1.24
   allocation `1032` and prior release history.
3. Run the applicable source, contract, Worker, architecture, docs, release
   notes, and candidate gates. For a public stable release, freeze a clean
   annotated source tag and pinned build identity before final production
   packaging. Keep any private candidate's source and build identity explicit.
4. Build and qualify the exact Mac artifacts on the required native builders;
   sign, notarize, staple, inspect Gatekeeper trust, and bind final DMG/ZIP
   hashes to their receipts. Also finalize and qualify the signed Windows x64
   installer and Linux x64 AppImage, each with exact integrity checks.
5. Test the exact packaged and installed successor: current ChatGPT bundle
   layout, legacy layout or synthetic equivalent, CLI absence, local ingestion
   independent of CLI availability, quota observation/freshness, cancellation,
   retries, prompt-free credential access, clean install, and signed upgrade
   from the published predecessor. Repeat target-specific installed/update
   gates for every public platform; do not reuse 0.1.24 owner exceptions.
6. For a public release, prepare and verify the four-target manifest and
   checksums, draft GitHub assets, native Sparkle transition feeds, Electron
   feeds, Homebrew and website changes in the runbook order. Publication and
   feed/website writes are separate protected operations; verify fresh
   downloads and installed updates after activation.

Current authorities: `docs/runbooks/2026-08-18-cross-platform-release-publication.md`,
`docs/runbooks/macos-stable-release-runbook.md`, and
`docs/reference/platform-support.md`.
