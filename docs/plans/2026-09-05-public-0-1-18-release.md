---
title: Public 0.1.18 release execution
date: 2026-09-05
type: plan
status: in-progress
---

# Public 0.1.18 release execution

The owner explicitly directed release after unlocking the Mac and accepting
the unavailable disposable-profile and physical Intel tests. This replaces the
earlier publication hold for the desktop release. The
[release-specific waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
records missing evidence honestly; no manual-v2 receipt is fabricated and no
data-integrity, native-signature, updater or unexpected-Keychain-prompt guard
is waived. Both macOS 14+ architectures are in scope. Stable build `1026`
must have new bytes from the final clean annotated `v0.1.18` source.

## Accepted starting evidence

- Branch `codex/release-0.1.18`, based on requested `origin/main` at `9e1c3333`;
  prior evidence HEAD `ce80f5f26650ce489e678e9ee2ff2adbb36fbedf`.
- [Signed RC3](../receipts/2026-09-04-macos-combined-rc3-signed-candidates.md)
  uses common source `7701debf44e046ac9f25bb74f7214532e32c5c5d`, dogfood
  build `1025.2`, exact independent ARM/Intel final-byte and RC2 replacement
  checks. RC1/RC2, verified runtimes and full pre-upgrade app/state backup remain
  preserved. RC3 cannot be relabeled stable.
- Source qualification: 3,859 root passes, zero failures, seventeen existing
  native-Windows skips; complete owning native/companion/Worker checks and
  ten fresh R7 receipts with both pinned-runtime reconstruction checks. Existing
  R7 resource decisions remain open, not silently promoted.
- Copy-only v14 migration and independent semantic/accounting preservation
  passed. The installed ARM RC3 production artifact validator also passed.
  Actual working-profile launch now succeeds; its direct companion exposes one
  loopback listener and reports a ready snapshot. Native-menu detailed refresh
  completed at 03:58 UTC with exact-generation replay-safe accounting; the
  [installed-runtime receipt](../receipts/2026-09-05-macos-rc3-installed-runtime.md)
  records the distinct stopped-state preservation proof. Normal relaunch is
  observed. No automatic Keychain prompt has been observed during these operations.
- Official Astra model/pricing and Codex credit pages were fetched again on
  2026-09-05 UTC. The eight API tier/context rows, strictly-above-272K boundary,
  cache-write multiplier and distinct Codex credit pricing remain unchanged.
  Sources: [API pricing](https://developers.openai.com/api/docs/pricing),
  [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra),
  [Codex pricing](https://learn.chatgpt.com/docs/pricing#token-rates).

## Ordered execution

- [ ] Complete installed ARM detailed refresh, exact-generation accounting,
  graceful quit, read-only historical preservation/integrity and relaunch.
- [ ] Finalize/review release notes, dated changelog, waiver and support wording;
  commit clean source, create exact annotated `v0.1.18`, rerun final preflight
  and release-note/source-contract gates. A pre-tag dated-note refusal is
  expected and is not a passing final gate.
- [ ] Finalize stable ARM and Intel `1026` independently; ARM uses verified
  previous stable `0.1.17`/`1024` continuity, Intel uses explicit first-stable
  bootstrap. Recheck source/payload, signatures, notarization/staples,
  Gatekeeper, Finder dates and exact final DMG bytes.
- [ ] Install final stable ARM, validate actual installed identity and ordinary
  launch/refresh/restart; retain the pre-upgrade app/state recovery pair.
- [ ] Generate complete signed appcasts and canonical native/checksum manifest
  with explicit null optional provenance/SBOM fields; no invented attestations.
- [ ] Atomically push the reviewed branch/tag, obtain exact-head CI and merge
  normally with identical tree/tagged ancestry. Do not push divergent local main.
- [ ] Create a draft with the exact manifest-derived asset set, download into a
  fresh directory and verify every digest/metadata subject before publishing.
- [ ] Publish immutable GitHub release, read back exact body/date/asset set,
  re-download, run release/asset verification, then publish downstream feeds,
  Homebrew ARM and the evidence-driven website with live byte/social checks.

## Hosted boundary

The admin model dashboard and Intel appcast guard require the reconciled
production schema and Worker deployment. Fresh read-only checks and a
backup/rollback assessment precede any remote write. The owner separately
approved applying the four reviewed production migrations `0042`–`0045` and
deploying the Worker, with contribution consent and v1.1 activation unchanged.
No migration, new contribution consent, v1.1 activation or owner erasure is
implied by the manual-testing waiver alone. Follow the
[lineage review](../reviews/2026-09-04-hosted-migration-lineage-reconciliation.md)
and [production runbook](../runbooks/production-operations.md); do not publish
an Intel feed until its authenticated guard is deployed and verified.

## Stop conditions

Preserve evidence and stop the affected operation for data loss/corruption,
unexplained accounting or source-binding failures, unexpected automatic Keychain
prompts, unsafe signing-key requests, dirty or ambiguous release identity,
failed CI/native checks, changed final bytes, mismatched draft downloads,
non-immutable publication, or unapproved remote data mutations. The owner's
manual waiver is not a general permission to bypass these protections.
