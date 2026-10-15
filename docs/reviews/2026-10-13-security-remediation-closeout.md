---
title: Security remediation integration and remaining gates
date: 2026-10-13
type: review
status: implemented
---

# Security remediation integration and remaining gates

This continues the [nine-finding implementation record](2026-10-12-security-findings-triage.md).
The coordinated source fixes are retained in `9037353a164455477cfeeaca435ca7d9eba63ec0`;
the independently reviewed collector creation correction is retained in
`80a1145c1e3c00b5e4e12aee56d4930c6f6d10ed`. Linux qualification integration is
retained in `d78dec05b60c2e24a9e59f47bfc05e0f68dda029`, followed by packaged
authority admission in `908ae053a9b538355d8bbb0a37b0d44716a9ba72`.
These are local commits on
`codex/security-findings-2026-10-12`. This record establishes source and local
test evidence, not signing, deployment, publication or installed-release proof.

An ordered independent review of findings 1 through 9 confirmed the source
remediations and their retained test lanes. It identified a further tooling
gap under finding 2: both Linux updater qualifiers required an authorized
successor renderer, but the updater restarts with an empty argument vector and
drops the debugger flags. Their successor health call had no authorized renderer
and could never complete. Coordinator review also found that both qualifiers
still constructed an unsigned feed with a noncanonical artifact name, which the
new runtime authenticator correctly refuses. Both qualification repairs are now
implemented and independently reviewed. Caller review also corrected packaged
qualification's stale requirement that the updater remain disabled after valid
publisher-root provisioning.

## Linux successor qualification follow-up

The implementation preserves the actual updater restart and separates two kinds
of evidence. The automatic restart must prove the exact next
image and process identity, predecessor termination, and a fresh owner-only
startup diagnostic. A subsequent controlled cold restart must prove authorized
renderer health and retained preferences/state, with the debugger listener bound
to the exact process before connection. An automatic startup diagnostic must
never be reported as authenticated companion or API health.

The change is confined to qualification scripts, tests and their documentation;
it adds no production debugging option or capability export. Required negative
checks cover stale/substituted diagnostics, unsafe ownership and links, timestamps,
process reuse/replacement, ambiguous process discovery, and wrong or changing
debugger socket ownership. Native Linux execution remains a separate gate.

Feed intake now requires exact, separately authorized signed metadata bound to
the admitted image and checks the actual packaged authority against reviewed
source. The positive feed remains byte-identical throughout qualification;
checksum rejection corrupts only a streamed artifact byte. The stored artifact
and signed metadata remain unchanged. New closed intake, pair and lifecycle
versions reject historical unsigned inputs and receipts.

The private-pair preparation command admits a frozen pair after separate
owner-authorized signing. The unsigned development workflow retains that pair
and explicitly reports native updater qualification as not performed. The
maintained release runbook supplies the exact preparation and isolated native
consumer commands. There is no automatic signer, production root override or
test-key injection. Provisioning alone cannot update the policy inside an older
packaged candidate.

Final archive review reproduced a further admission gap with actual synthetic
ASAR archives: the final qualifier followed links, accepted unpacked host-side
policy files, and allocated oversized entries before checking their length.
The corrected reader rejects linked ancestors and entries, unpacked entries,
and sizes outside 1 byte through 1 MiB before extraction, matching the private
qualifier's boundary. Its complete owning file passed 12 tests, including five
actual-archive negative cases; independent archive probes and review passed.

Independent successor review passed 126 focused tests and six further actual
process-reader regressions using synthetic process adapters. Independent
signed-feed integration review closed with 124 unique targeted tests after the
archive correction; the separate packaged
availability correction passed 32 tests and review. The final installed-lifecycle
owner passed 85 tests. These overlapping focused runs are not an aggregate test
count or evidence of a native Linux run. The ordered caller audit found no
remaining source omission across runtime verification, private/final
qualification, package validation, signing, publication and renewal.

## Protected R7 refresh attempt

The owner-authorized refresh ran locally against clean `80a1145c1e3c`, following
the [maintained R7 runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md).
Both exact pinned runtime identities were verified before execution. All six
synthetic semantics, pressure and materialized-boundary phases completed across
Node 24.14.0 and Node 26.2.0.

The shared real-history source-plan creation then stopped with the closed
diagnostic `operation=create source=claude_transcript reason=export_resource_line_bytes`.
The configured line bound is 16 MiB. It applies before record/type selection and
interval filtering; the same diagnostic can arise from a complete line or the
unfinished tail. The evidence does not identify which path failed, its actual
size, or whether the refused data belongs to the measured interval. This is an
input admission refusal, not demonstrated evidence of a source implementation
bug.

The generator exited unsuccessfully before source-plan freeze confirmation or
atomic receipt replacement. All ten retained receipts remain byte-identical to
the committed versions, and no journal, staging or backup artifacts remain.
The subsequent freshness test ran two tests and both failed only on the expected
workload digest mismatch. There is no completed fresh matrix or release decision.
No private input was changed, omitted, copied into tests, printed or uploaded;
no limit was increased, partial evidence reused, or retry performed.

The original security fixes remain implemented, but the R7 evidence gate is open.
A further R7 investigation must preserve the admission limit and provenance,
establish a specific source defect or an explicitly approved input policy before
changing behavior, and regenerate the complete matrix after any relevant fix.

## Ordered status and remaining handoffs

| Finding | Source status | Remaining gate |
|---|---|---|
| 1. Windows signing trust | Implemented and independently reviewed | Provision reviewed tool/publisher pins; qualify the isolated signer, egress and installed artifacts on Windows. |
| 2. Linux update authenticity | Implemented; qualifier integration and independent review complete | Provision publisher roots, build matching candidates, supply exact authorized signed metadata, and run native update qualification. |
| 3. Relay session inheritance | Implemented and independently reviewed | Qualify the real browser ceremony if the optional legacy relay is deployed. |
| 4. Local caller authorization | Implemented and independently reviewed | Qualify native Electron frame behavior; Windows standalone unlock remains unavailable pending its ACL contract. |
| 5. Appcast body admission | Implemented and independently reviewed | Provision/read back dedicated production bindings and qualify signed publication. |
| 6. Provider error privacy | Implemented and independently reviewed | Packaged-platform qualification remains separate. |
| 7. Public probe admission | Implemented and independently reviewed | Provision/read back bindings, deploy, and qualify actual throttling/backend behavior. |
| 8. Linux extraction isolation | Implemented and independently reviewed | Run Docker containment and lifecycle qualification on a suitable Linux host. |
| 9. Documentation privacy | Implemented and independently reviewed | No further local security remediation; publication remains separate. |

The original dispatched handoff briefs and per-finding acceptance criteria remain
in the October 12 record. No agent should repeat completed patches or treat
unprovisioned trust as permission to create credentials. Protected production
operations require the relevant maintained runbook and authorization for that
outcome.

## Integration validation

The prior complete root run and subsequent collector-focused correction are
recorded in the October 12 review. A superseded integration run was stopped
after the final ASAR correction arrived; it is not completed-suite evidence.

The complete permitted root run at `908ae053a9b538355d8bbb0a37b0d44716a9ba72`
executed 6,242 tests: 6,189 passed, five failed, one was cancelled and 47 were
platform-skipped (1,870.27 seconds). Two failures are the expected stale R7
receipt checks. Two Linux container tests retained the historical unsigned
qualification route and COPY inventory. The Windows compatibility ledger had
not recorded three new POSIX-specific collector assertions.

The three contract failures were corrected without changing product behavior.
Linux tests now check both the ordinary unsigned workflow and the protected
signed-input runbook command, retaining isolation checks and enforcing the exact
container input allowlist. The combined owning/package/updater files passed
31/31; independent review passed the five owning tests and rejected eight
synthetic command/allowlist regressions without weakening isolation. The Windows
ledger now records all five branches and their outstanding
native ACL and crash-recovery equivalents; its owning test passed 1/1.

The materialized-boundary benchmark was cancelled by its unchanged 30-second
test timeout. Its entire unchanged owning file then passed 2/2 in 8.07 seconds,
with the main benchmark completing in 7.73 seconds. This is a retained timing
flake; the exact cause of the slower full-run execution is unproven. Neither
the timeout nor the benchmark assertions were changed.

The focused checks verify the three inventory corrections and reproduce a
passing benchmark run; they do not constitute another full root run. The two
stale R7 freshness failures remain unresolved, and the timing flake is retained
above. The aggregate root gate is not green, and no release or deployment is
qualified by these results.

Final documentation governance, architecture, preflight (22 tests) and release
trust (87 tests) passed. Architecture inspection covered 663 production files
and 2,721 imports with no approved debt edges. These local checks do not replace
the operational gates in the ordered handoff table.
