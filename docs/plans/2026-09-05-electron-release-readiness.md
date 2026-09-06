---
title: Electron readiness after the native 0.1.18 release
date: 2026-09-05
type: plan
status: in-progress
---

# Target and baseline

Prepare one Electron app for Apple Silicon Mac, Intel Mac, Windows x64 and
Linux x64. Keep provider support inside that app. Preserve the accepted
[accountless sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md)
and finish local and hosted integration without treating development packages
as production qualification.

The published [native 0.1.18 release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.18)
was verified on 2026-09-05. Its annotated tag resolves to
`55c813a1bf7e67c00e47410b760104c0d9fbc0ea`. Electron starts this pass at
`14e6a02c131936177cbb0acf1d801d3653658a1b`; its shared desktop accounting/cache
release fixes are already present. Remaining release-branch differences are
hosted Worker repairs and release evidence, not a missing local accounting
implementation. Reconcile those differences deliberately with the accountless
schema work.

All four unsigned development targets passed [run 33979427838](https://github.com/adamallcock/tibotattle/actions/runs/33979427838)
at that exact Electron source. Mac popup inspection and interaction evidence
are retained in the local tester handoff. The older tracked tray QA record is
a point-in-time record and predates the final control fix and package run.

The original dirty accountless checkout is preserved. A private patch/file
snapshot was made before applying its changes to this isolated integration
checkout. The generated translation mirror was rebuilt from both sets of
canonical entries; the tested tray changes remain in place.

## Completion sequence

1. Reconcile released Worker fixes and finish the reviewed accountless ownership
   source migration with preservation tests. The earlier automatic-review
   rejection remains a gate: explicit source-only/disposable-database approval
   is pending under the [prepared migration proposal](../reviews/2026-09-05-accountless-migration-proposal.md).
2. Exercise the real local Worker enrollment and encrypted v1.1 pipeline from
   the desktop client: one installation namespace for usage/quota, lost-response
   duplicate retries, expiry/revocation, restart and opt-out fencing. Preserve
   the existing social path and accountless public-aggregate exclusion.
3. Resolve remaining page/navigation gaps, starting with verified parent links
   for Auto Review cache drops. Inspect rendered fixtures and the final packaged
   app; source inspection alone is not page parity.
4. Complete the Mac state/credential/update cutover and equivalent Windows/Linux
   runtime composition. Keep each platform's capability declarations tied to
   its actual adapter and artifact evidence; do not enable a platform by changing
   readiness booleans.
5. Run focused checks, affected surface gates, copied-profile responsiveness,
   then regenerate four development packages for the final integrated source.
   Retain failures and distinguish cold, idle and active-refresh measurements.

## External gates

This pass authorizes source work, isolated tests and the existing development
branch/CI flow. Remote migrations, deployments, hosted activation, real uploads,
signing, system-app replacement and publication remain separate operations.
Physical Intel/Windows/Linux behavior and installed update recovery must be
qualified on those targets before public support is claimed.

## Integrated local checks

The preserved contribution prototype combined with the final tray source
passed 122 focused contribution/projection/retry tests before the next
credential-hardening edits. Architecture and documentation checks passed.

The desktop laboratory now constructs the protected credential adapter after
Electron readiness and carries it over the existing private child channel.
Normal desktop launches still cannot activate that laboratory through ambient
environment variables. An actual owned-child test composes the desktop, local
contribution scheduler and encrypted synthetic credential store; it covers
opt-out during a pending pass, restart off, and re-enable retaining the same
credential. Its runner performs no enrollment or upload, so this is local
composition evidence and does not replace the pending real-Worker test.

On 2026-09-06 the combined source passed 542 web tests, 315 local-companion
tests, and 437 Electron/contribution security tests. The final configuration
shape change then passed all 24 owning desktop-runtime tests. The first
restricted runtime invocation could not start its loopback child; the same
suite passed with local loopback access. That environment failure is retained
alongside the successful log. Architecture, documentation, and the 20-test
preflight also passed.

Auto Review cache-drop rows now resolve only a verified ordinary parent from
the selected local Codex store and bounded session metadata. Unavailable or
review-to-review parents produce a non-link label. All 66 owning tests passed;
the actual cell renderer with the unmodified stylesheet was inspected using
synthetic rows. This is renderer evidence, pending the fresh packaged-app
inspection. No ledger attribution changes accompany the navigation fix.

The released Worker repairs have been reconciled, including the exact released
0043–0045 migration bytes, bounded analytical queries, and current snapshot and
administrative tooling. Migration 0046 remains an upload-free enrollment ledger;
no 0047 migration or ownership route has been added. An independent review of
the local credential and IPC boundary found no blocking issue. These results
do not remove the pending source-migration approval or hosted end-to-end gate.

Earlier detailed implementation and evidence remain in the
[contribution integration plan](2026-09-04-accountless-integration-and-responsiveness.md)
and [desktop convergence plan](2026-09-04-desktop-convergence.md). This short
record coordinates the remaining work against the published release.
