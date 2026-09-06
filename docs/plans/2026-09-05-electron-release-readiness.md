---
title: Electron readiness after the native 0.1.18 release
date: 2026-09-05
type: plan
status: in-progress
---

# Objective and current position

Updated 2026-09-06. Deliver one primary Electron application for Apple Silicon
Mac, Intel Mac, Windows x64 and Linux x64, with one shared product and release
process. Provider support stays inside that app. The accepted
[sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md) remains
fresh-install automatic sharing, persistent opt-out, no sign-in, and three
visible notices before activation for existing undecided installations.

The current tested development candidate is
`65a1132bf5ecf4505a8c3d1d456cb1f955db8cea`. Its four unsigned packages passed
[CI run 34012137047](https://github.com/adamallcock/tibotattle/actions/runs/34012137047).
The Mac app started, its owned companion reported ready with hosted
contributions disabled, and a copied-history refresh completed. The shared
accounting/cache release changes are present; released Worker repairs were
also reconciled. Native 0.1.18 is the predecessor baseline, whose tag resolves
to `55c813a1bf7e67c00e47410b760104c0d9fbc0ea`.

This establishes a development candidate, not a production replacement.
Final rendered inspection of the corrected package remains uncompleted after
the Mac locked. The current update UI is disabled. Accountless scheduling and
credentials work only in the injected local laboratory; ordinary distributed
launches do not have accountless upload authority. Physical platform and
installed upgrade evidence remain incomplete.

# Workstreams and completion evidence

| Workstream | Remaining work | Required demonstration |
| --- | --- | --- |
| 1. Product and background parity | Finish a fixed page/action matrix against native 0.1.18: overview, allowance, trends, usage/cost/cache, community, settings/about and tray. Compare accounting, quota, refresh, retry/cancel, persistence and relevant hosted/admin behavior on the same evidence. Record intentional visual differences. | Exact packaged candidate passes journeys, with no unexplained data/behavior differences or unresolved blocking interaction defects. Cold, active-refresh and recovery behavior remain usable. |
| 2. Native Mac handover | Implement production state/credential migration, stable app identity, exclusive writer ownership and old login-item handover. Preserve history, identity salt, settings and sharing choices; test interrupted migration and recovery. | Supported native predecessor upgrades to signed Electron without loss, duplicate writers/uploads or reset choices; restart and interrupted migration recover. Cover both Mac architectures. A copied development profile does not satisfy this gate. |
| 3. Accountless contributions | Implement the reviewed ownership/schema bridge; connect enrollment, private credentials, authorization and the existing encrypted upload pipeline. Preserve old social clients. Complete disclosure/reminder delivery and production activation controls. | Fresh automatic sharing; three actual notices for existing undecided installs; persistent explicit opt-out; usage/quota linkage across provider/account changes; deduplicated lost-response retries; bounded abuse; revocation/expiry and no unexpected public aggregate admission. Test first against disposable synthetic Worker databases, then an authorized controlled hosted rehearsal. |
| 4. Production packaging and updates | Turn the four-target development pipeline into one production pipeline: final app identity, signing/trust, compatible pinned updater, architecture-correct feeds, protected release metadata and safe interrupted-update handling. | A signed/trusted Electron candidate updates to a subsequent signed/trusted Electron candidate on each claimed target. Installers, update payloads, checksums and support/download metadata identify the same frozen source/version. |
| 5. Platform runtime qualification | Finish Windows/Linux production adapter composition where still gated. Exercise actual credentials, filesystem permissions, tray, notifications, login startup, sleep/resume, install/upgrade/uninstall and recovery on declared environments. | Reproducible native runtime/lifecycle receipts for Apple Silicon, Intel, Windows x64 and the explicitly supported Linux environment(s). A build or container pass alone is insufficient. |
| 6. Rollout and native retirement | Integrate through one source/release line; prepare compatible backend rollout, tester cohorts, support/privacy copy, recovery instructions and a defined observation window. Retain long-tail native migration access. | Controlled rollout succeeds, subsequent Electron update succeeds, all advertised targets qualify, and the observation/recovery gate passes before the active native feature/build lane retires. |

# Execution order

The earliest decisive milestone is **native 0.1.18 -> Electron candidate ->
next Electron candidate**, preserving data and choices throughout. Prioritize
streams 2 and 4 together; this tests the most consequential unproven part of
the transition. Test supported 0.1.17 upgrade paths as well, or provide a
qualified bridge rather than silently excluding users who skipped a release.

Run product parity, accountless integration and Windows/Linux preparation in
parallel. The accountless schema approval does not block product QA, updater
source work, migration design or platform qualification preparation. Likewise,
a locked Mac blocks visible inspection, not the rest of the programme.

Use three explicit readiness milestones:

1. **Daily-use tester:** product journeys pass on the packaged Mac candidate,
   copied-profile refresh/cancel/restart are reliable, known limitations are
   visible, and the original installation is preserved. This is the next
   short completion target; it can precede hosted contribution activation.
2. **Release candidate:** real native migration, accountless end-to-end tests,
   production updater/signing and required native platform journeys pass on
   frozen candidates. The next Electron update is part of this milestone.
3. **Primary public app:** authorize compatible server preparation and staged
   client rollout, verify live delivery and updates, then retire native feature
   development after the agreed observation/recovery gate. Four-platform
   support requires all four platform gates; earlier previews are labelled.

One programme and one intended app release do not require one simultaneous
production switch. Prepare backward-compatible server changes before client
activation. Test local app migration while contribution sending is held, then
test the full enabled policy before its release. A temporary hold must be
explicit in tester copy; it must not silently become a change to the accepted
fresh/existing-install sharing policy.

# Scope and ownership that keep this bounded

- Assign narrow owners for product parity, migration, contribution ownership,
  and distribution/platform adapters. Use one integration owner and one
  acceptance ledger. Parallel agents can implement and review isolated pieces;
  physical-device and signing evidence still requires the actual environments.
- Reconcile the released base once, then bring necessary shared fixes through
  the integration line. Keep native-shell changes to urgent fixes and migration
  support; new features target the shared app. Do not create another detached
  "latest features" product or competing release manifest.
- Keep current primary package formats: two thin Mac packages, Windows NSIS,
  and Linux AppImage with its declared support environment. Additional stores,
  Linux formats, universal Mac packaging and more CPU targets are outside the
  initial cutover. One source can still produce platform-specific binaries.
- Reuse electron-builder and a compatible pinned electron-updater behind the
  existing release trust policy. [Official updater documentation](https://www.electron.build/docs/features/auto-update/)
  confirms the existing Mac/NSIS/AppImage direction; it does not qualify this
  repository's pinned versions. Sign early in migration/update experiments:
  [Electron documents](https://www.electronjs.org/docs/latest/tutorial/code-signing)
  that Mac key storage, login registration and updating depend on app signing.
- Keep Claude off the initial shell migration critical path. Enable it later
  through the same shared provider interface and the same four packages.
- Timebox the direct native-updater-to-Electron handover experiment. If it is
  not viable, select a minimal bridge or a guided signed install with the same
  data-preservation checks. Do not build a general migration framework.
- Set a short initial budget for that handover/updater spike and product QA,
  then estimate the release date from its results and confirmed hardware/
  signing access. A calendar promise before those checks would be speculative.

# Evidence and outstanding access

The previous candidate `88245f7d` passed CI but failed actual startup because
its Electron inventory omitted the credential adapter. It remains rejected;
its failure evidence and disabled launcher are preserved. Candidate `65a1132b`
adds both the missing file and a mandatory staged module-linkage check, including
an isolated plain-Node load before package staging completes. This failure is
why artifact execution is a required gate in addition to source tests.

Relevant affected suites passed: 542 web, 315 local-companion, 437 combined
Electron/contribution security checks, 24 final desktop-runtime checks, 66 Auto
Review checks, and 570 Worker tests plus its script/package/type checks. The
Worker's dry-deployment/staging portions passed locally after preparing the
required generated site artifact. This is component-wise gate evidence; the
full root/native artifact suite is not claimed green.

The corrected Mac candidate's 45-second active interval had 180 successful
rounds, per-endpoint p95 1 ms, and maxima of 22 ms (health) and 7 ms (refresh
status), within the unchanged 250 ms p95 budget. This does not cover every cold
or quick-publication phase, renderer responsiveness or UI Quit. Keep those
qualification cases in the product journey ledger.

Current dependencies are an unlocked Mac for final visible QA, actual target
OS/desktop environments, production signing/update access, and the pending
[source-only accountless migration approval](../reviews/2026-09-05-accountless-migration-proposal.md).
Automatic approval review rejected rebuilding the ownership tables without
specific authorization. The pending request is for source implementation and
fresh disposable synthetic D1 rehearsals only; no 0047 migration or routed
ownership endpoint has been added. Remote migrations, hosted activation,
signing, installed replacement and publication remain separate authorizations.

The larger [desktop convergence plan](2026-09-04-desktop-convergence.md) and
[contribution integration plan](2026-09-04-accountless-integration-and-responsiveness.md)
retain the detailed design history. This document coordinates the remaining
work and exit criteria for the current candidate.
