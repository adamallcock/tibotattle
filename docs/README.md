# Documentation index

Program documentation lives here, grouped by document type. Dated filenames are
preserved for traceability; a date alone does not make a document current.

For present-day work, start with the maintained entry points below and read the
status and boundary at the top of each document. These paths describe local
checks and owner-only gates; they do not establish that remote deployment,
signing, artifacts, an appcast, or updater infrastructure is operational.

## Current operational entry points

| Path | Use |
|---|---|
| [`runbooks/2026-08-04-owner-release-execution.md`](./runbooks/2026-08-04-owner-release-execution.md) | Owner-run release sequence; fail-closed until each external gate is observed |
| [`runbooks/2026-08-05-internal-dogfood-versus-release-readiness.md`](./runbooks/2026-08-05-internal-dogfood-versus-release-readiness.md) | First-read boundary between the installed ad-hoc preview and a signed release candidate |
| [`runbooks/2026-08-04-staging-release-verification.md`](./runbooks/2026-08-04-staging-release-verification.md) | Credential-free production-containment observer and live-proof boundary |
| [`runbooks/2026-08-04-disabled-staging-readiness-boundary.md`](./runbooks/2026-08-04-disabled-staging-readiness-boundary.md) | Static and owner-authorized staging checks; staging remains unprovisioned until verified |
| [`runbooks/2026-08-04-internal-update-rehearsal.md`](./runbooks/2026-08-04-internal-update-rehearsal.md) | Disposable-profile N→N+1 rehearsal; not signing or feed-publication proof |
| [`runbooks/2026-08-02-r2-sparkle-update-publisher.md`](./runbooks/2026-08-02-r2-sparkle-update-publisher.md) | Local Sparkle/R2 publication contract; remote feed readiness still requires owner evidence |
| [`runbooks/2026-08-04-open-enrollment-controlled-release.md`](./runbooks/2026-08-04-open-enrollment-controlled-release.md) | Account-gated contribution release path; external authorization remains an owner action |

The remaining folders are records, evidence, or supporting context rather than
a single current operating procedure. Treat receipts, audits, reports, and QA
artifacts as point-in-time evidence; use their status and dates before relying
on them for a fresh state claim.

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
| [`research/`](./research/) | Source notes and supporting research artifacts |
| [`qa/`](./qa/) | Browser and native visual QA receipts and screenshots |
| [`design/`](./design/) | Product and visual design briefs |
| [`reference/`](./reference/) | Historical product and implementation references, including the relocated full product reference |
| [`runbooks/`](./runbooks/) | Operator runbooks and handoff notes; use the current entry points above |

The repository root [`README.md`](../README.md) remains the primary product and developer entry point.
