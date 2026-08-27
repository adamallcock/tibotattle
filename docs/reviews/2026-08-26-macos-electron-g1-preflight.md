---
title: macOS Electron G1 Physical-Qualification Preflight
date: 2026-08-26
type: review
status: stopped after bounded repair; package not built
---

# macOS Electron G1 Physical-Qualification Preflight

## Outcome

G1 did not advance to packaging. The bounded implementation and repair passes
found and fixed one real product defect, but final independent review showed
that the proposed physical-QA harness changes could still both false-pass and
false-fail. Building an artifact at that point would not produce trustworthy
exit evidence.

No Electron package was built or launched, no GUI was controlled, no selected
Codex history was ingested, and no release, push, deployment, version bump, or
signing operation occurred.

## Product fix retained

Commit `a76942b3` keeps the renderer's elapsed deep-accounting counter advancing
after both bounded continuation and timeout-settling paths. Those paths already
reset the local outcome to `running`, but did not reset `latestOutcome`; the
display timer therefore appeared frozen while work continued.

Validation for the product fix:

- focused renderer cadence and shared renderer tests: 227 pass;
- full `npm run product:ui:test`: 397/397 pass;
- syntax, architecture, and diff checks: pass.

## Intended G1 bounds

The attempted QA changes targeted these explicit gates:

- quick result within 30 seconds;
- five advancing elapsed-time observations;
- loopback control-plane p95 below 250 milliseconds;
- cancellation acknowledged within two seconds and terminal within ten;
- retry accepted with a new refresh identity;
- full refresh terminal within 15 minutes; and
- exact-artifact Dashboard, Usage, Community, Settings, Share, sidebar,
  renderer-health, relaunch, and clean-quit evidence.

The selected real-history corpus currently contains approximately 6,100 active
and archived session files occupying about 143 GB. The 15-minute threshold is
therefore an intentionally strict product target, not the companion's general
two-hour safety timeout.

## Why the QA changes were not committed

Final independent review found no content leak or production regression, but it
found P1 proof defects that prevent a trustworthy G1 receipt:

### Packaged macOS smoke

- ordinary allowance displays such as `80%` are rejected because the toolbar
  snapshot does not provide the numeric value expected by its classifier;
- top-level `passed` receipts can still be constructed without mandatory
  toolbar, sidebar, startup, parity, Settings, Share, or renderer evidence;
- sidebar persistence is read before its asynchronous bridge write is known to
  have completed;
- exactly-once startup observation can seal before a late refresh request;
- descendant-only shutdown checks can miss a reparented companion;
- the dashboard toolbar image check does not prove the native macOS status-item
  icon, including the reported white-square failure; and
- a CDP connection-timeout path can leak its WebSocket.

### Real-history QA

- separate acceptance and terminal budgets can consume roughly twice the
  stated 15-minute limit;
- the observer can seal before the production continuation decision;
- degraded Community and advanced-module receipt evidence has incomplete
  independent validation;
- the CLI can print a fail-closed `failed` receipt while exiting successfully,
  and can suppress a requested receipt-persistence failure;
- direct Node probes prove companion responsiveness, not the renderer's own
  polling path; and
- forced cleanup does not return a newly verified descendant-free result.

The experimental changes to the two macOS harnesses and their contract tests
remain uncommitted in the isolated reconciliation worktree. They are not
qualification evidence and must not be packaged or merged as-is.

## Stop condition and next bounded task

The G1 implementation-plus-repair allowance is exhausted, so work stops here
instead of starting another repair loop. A new, explicitly bounded follow-up
must first make both receipt builders independently fail-closed, align one
absolute duration budget, observe continuation and renderer-owned control
traffic, poll asynchronous persistence, and prove process ownership. It then
needs one clean independent audit before any exact-digest package is built.

Native status-item icon/menu behavior, Share Save/Copy completion, Settings
mutations, close-to-hide/frontmost restore, and real visual parity remain
physical acceptance items even after those harness defects are fixed.
