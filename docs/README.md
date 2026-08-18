# Documentation index

Program documentation lives here, grouped by document type. Dated filenames are
preserved for traceability; a date alone does not make a document current.

For present-day work, start with the maintained entry points below and read the
status and boundary at the top of each document. These paths describe local
checks and owner-only gates; they do not establish that remote deployment,
signing, artifacts, an appcast, or updater infrastructure is operational.

## Current authoritative operational entry points

| Path | Use |
|---|---|
| [`plans/2026-08-14-mac-app-store-compatibility-plan.md`](./plans/2026-08-14-mac-app-store-compatibility-plan.md) | Active Store feasibility and dual-distribution plan; not a Store-readiness or submission claim |
| [`runbooks/2026-08-04-owner-release-execution.md`](./runbooks/2026-08-04-owner-release-execution.md) | Owner-run release sequence; fail-closed until each external gate is observed |
| [`runbooks/2026-08-05-internal-dogfood-versus-release-readiness.md`](./runbooks/2026-08-05-internal-dogfood-versus-release-readiness.md) | First-read boundary for the installed ad-hoc preview, future signed `internal-dogfood`, and stable; not a release claim |
| [`plans/2026-08-05-provider-reported-quota-windows.md`](./plans/2026-08-05-provider-reported-quota-windows.md) | Current provider-reported quota-window implementation and plan-evidence boundary; not release authorization |
| [`runbooks/2026-08-04-staging-release-verification.md`](./runbooks/2026-08-04-staging-release-verification.md) | Credential-free production-containment observer and live-proof boundary |
| [`runbooks/2026-08-04-disabled-staging-readiness-boundary.md`](./runbooks/2026-08-04-disabled-staging-readiness-boundary.md) | Static and owner-authorized staging checks; staging remains unprovisioned until verified |
| [`runbooks/2026-08-04-internal-update-rehearsal.md`](./runbooks/2026-08-04-internal-update-rehearsal.md) | Disposable-profile N→N+1 rehearsal; not signing or feed-publication proof |
| [`runbooks/2026-08-02-r2-sparkle-update-publisher.md`](./runbooks/2026-08-02-r2-sparkle-update-publisher.md) | Local Sparkle/R2 publication contract; remote feed readiness still requires owner evidence |
| [`runbooks/2026-08-04-open-enrollment-controlled-release.md`](./runbooks/2026-08-04-open-enrollment-controlled-release.md) | Account-gated contribution release path; external authorization remains an owner action |
| [`runbooks/2026-08-13-community-allowance-band-diagnosis.md`](./runbooks/2026-08-13-community-allowance-band-diagnosis.md) | Diagnose a missing or stale public allowance band through fit-cache and aggregate state; production writes remain owner-run |
| [`decisions/2026-08-15-homebrew-distribution-and-macos-support.md`](./decisions/2026-08-15-homebrew-distribution-and-macos-support.md) | First-party Homebrew tap, update automation, uninstall boundary, and supported macOS floor |
| [`goals/2026-08-17-four-day-windows-readiness-goal.md`](./goals/2026-08-17-four-day-windows-readiness-goal.md) | Bounded portable-core qualification for issue #3; explicitly not Windows support |
| [`runbooks/2026-08-17-windows-portability-environments.md`](./runbooks/2026-08-17-windows-portability-environments.md) | Restore macOS, network-isolated Linux, native Windows x64, and optional UTM development lanes |

Documents not listed above remain records, evidence, or supporting context
rather than current operational authority. Treat receipts, audits, reports,
and QA artifacts as point-in-time evidence; dated plans and decisions preserve
historical intent unless explicitly linked above. Read each document's status
and date before relying on it for a fresh state claim.

## Records and supporting material

| Folder | Contents |
|---|---|
| [`v0.3/`](./v0.3/) | Usage Monitor v0.3 goal, final validation, and milestone decision records |
| [`goals/`](./goals/) | Program-level goals and completion criteria |
| [`plans/`](./plans/) | Implementation and release plans |
| [`decisions/`](./decisions/) | Decision records outside the v0.3 milestone set |
| [`receipts/`](./receipts/) | Verification, validation, and checkpoint receipts |
| [`governance/`](./governance/) | Risk register, control traceability, privacy contract, preregistrations |
| [`reports/`](./reports/) | Consolidated readiness and status reports |
| [`audits/`](./audits/) | Journey audits and gap reviews |
| [`reviews/`](./reviews/) | Point-in-time implementation, architecture, and reconciliation reviews |
| [`research/`](./research/) | Source notes and supporting research artifacts |
| [`qa/`](./qa/) | Browser and native visual QA receipts and screenshots |
| [`design/`](./design/) | Product and visual design briefs |
| [`reference/`](./reference/) | Historical product and implementation references, including the relocated full product reference |
| [`runbooks/`](./runbooks/) | Operator runbooks and handoff notes; use the current entry points above |

The repository root [`README.md`](../README.md) remains the primary product and developer entry point.
