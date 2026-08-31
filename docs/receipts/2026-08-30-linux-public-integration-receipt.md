---
title: Linux public integration verification receipt
date: 2026-08-30
type: receipt
status: source-qualified-r7-evidence-blocked
base_revision: 49fc02766c4bb7434b62ccd378d21b2d4ebf5e71
source_revision: 5764d5f555460db2164e9fb9662dd87c6b106268
---

# Linux public integration verification receipt

## Claim and publication boundary

[PR #82](https://github.com/adamallcock/tibotattle/pull/82) integrates the four
dormant Linux foundations into `codex/linux-integration` only. Its source branch
is `codex/linux-foundation-public-20260830`. This is a development integration,
not Linux production activation, an installed-app qualification, or a release.
The native macOS client, `main`, and Windows branches are not merge targets.

The public base is the already-published Electron revision
`49fc02766c4bb7434b62ccd378d21b2d4ebf5e71`. The Linux changes were reconstructed
on that base instead of publishing ten intervening local Electron/macOS
commits and their private-history review. Those ten commits are not ancestors
of the PR head; the original local Linux branch remains preserved. No raw
history, credentials, databases, native payloads, or generated protected
receipts are added by this PR.

The [August 27 receipt](./2026-08-27-linux-parallel-foundation-receipt.md)
remains an unchanged historical record of the original local revision. Its
source and image identities are not substituted for the fresh public-branch
results below.

## Qualified revision

The implementation and test revision exercised here is
`5764d5f555460db2164e9fb9662dd87c6b106268`. It includes the Linux implementation,
the original historical documentation, and a narrow Electron test
synchronization repair. A subsequent documentation-only commit records these
results; it is not the image's baked source identity.

At the qualified revision, the 36 original Linux-delta files were byte-identical
to the original completed local foundation revision. The additional Electron test edit waits for the
mock companion's actual spawn signal, bounded by the existing timeout and
raced against launch failure, instead of assuming one event-loop turn is
sufficient for asynchronous filesystem inspection. Assertions and cleanup
remain intact; no runtime behavior is changed by this test repair.

## Fresh validation ledger

| Lane | Result |
| --- | --- |
| Linux foundation suite | `pnpm test:linux:foundation`: 92 tests, 91 passed, 0 failed, 1 explicit native-Linux-x64 skip |
| Electron suite | 300 passed, 0 failed on the reconstructed public branch; the repaired packaged-companion test also passed five focused repetitions before the port |
| Architecture | 440 production files, 1,704 imports, 0 approved debt edges |
| Tool inventory | Complete: 108 records, 109 executable paths, 67 aliases |
| Documentation and diff | Documentation-link check and `git diff --check` passed |
| ARM64 image build | `pnpm container:electron-linux:build` passed from the clean qualified revision |
| ARM64 source GUI smoke | `pnpm --silent container:electron-linux:test` passed; execution used `--network none` |
| Full root suite | `pnpm test`: 3,736 tests, 3,666 passed, 2 failed, 68 explicit skips; exit 1 |
| Automatic PR checks at the qualified revision | Release evidence and workflow policy passed; dependency-lock OSV scan passed |
| Publication-scope review | Public base and excluded ancestry verified; no new raw-history, credential, database, native-payload, or generated protected-receipt additions |

The two full-root failures are
`every retained R7 release receipt revalidates against current code and contract`
and `retained decision receipt is rebuilt exactly from all eight runtime inputs`
in `test/r7-generated-release-evidence.test.js`. They report stale
`workloadCodeSha256` and `workloadCodeFileCount` provenance. The full suite is
not green, and passing automatic PR policy/security checks do not override that
release-evidence boundary.

During preliminary validation of the original local lineage, missing worker
dependencies caused two setup failures; installing the worker's existing
lockfile resolved them. An R7 synthetic-smoke determinism assertion also failed
in that preliminary run, then passed an isolated rerun and the final full run
on the public branch. No assertion or R7 implementation was weakened. Those
preliminary runs are diagnostic history, not the final qualification counts.

## Exact ARM64 source-container evidence

The existing Colima VM was restarted with its macOS Virtualization.Framework,
`aarch64`, Docker, and `virtiofs` configuration. No new VM or maintainer keyring
was used.

- Image: `sha256:f6b3a32d01f7781214898d3900fa8949ba8692cdf0ae2df7dbdefd15f107ff12`.
- Image platform: `linux/arm64`; runtime architecture: `arm64`.
- OCI revision label and smoke source revision:
  `5764d5f555460db2164e9fb9662dd87c6b106268`.
- Smoke status: `passed`; qualification: `development-only`.
- Browser: `Chrome/150.0.7871.129`.
- Dashboard reached a validated loopback origin; nine descendants were
  recorded at readiness.
- Renderer reload, loopback-only runtime-interface proof, exact descendant
  cleanup, and clean quit passed under `--network none`.
- CDP minimize/restore was unavailable and reported as false, not inferred.
- Startup refresh ended in the allowed degraded state
  `codex_rollout_lineage_invalid`; the GUI/process/network gates passed. This
  is not a successful-history-ingestion claim.

This run is source-checkout ARM64 development evidence only. It does not prove
native AMD64, a desktop-manager tray, a user's session bus or keyring,
AppImage packaging, installation, or release trust.

## Protected evidence and production gates

The retained R7 receipts remain source-stale. The prior August 27 regeneration
attempts encountered an independent private-history integrity blocker,
recorded in their historical receipt. No private-history inspection, recovery,
mutation, or receipt regeneration was attempted for this August 30 public
integration. Resolving that protected gate still needs a separately authorized,
preserve-first recovery decision; this PR does not claim it is resolved.

The manual native AMD64 workflow is published as source but has not been
dispatched. Warm and clean native x86_64 receipts, including the isolated
D-Bus/Secret Service lifecycle, remain required. A process-local credential
lease and injected classifier seam are not a crash-safe cross-process lease or
a production libsecret error classifier.

Production selectors and runtime staging remain unchanged. Point-of-I/O XDG
ownership and retention, a native identity-bound autostart mutation primitive,
real X11/Wayland tray and session behavior, Linux runtime staging, AppImage
construction and verification, installed lifecycle, upgrade/rollback/uninstall,
signing, and publication remain separate, unqualified gates.
