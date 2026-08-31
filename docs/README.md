# Documentation index

This index separates maintained truth from point-in-time evidence. Start with
the current authorities below. A dated filename does not make a document
current, and source, local runtime, native app, installed artifact, CI, release,
updater, and public deployment remain separate evidence gates.

When maintained behavior changes, update the affected authority in the same
change. Git-remove obsolete instructions, plans, reports, and handoffs once
they no longer have enduring audit, recovery, decision, or release value. Git
history is the default archive; do not keep wrong prose in the working tree as
an informal archive.

## Current authoritative documentation

| Area | Authority | Boundary |
|---|---|---|
| Status | [Current product and release status](./current-status.md) | Commit- and date-stamped source, live-service, published-release, updater, and support snapshot; reverify before relying on it later |
| User help | [User guide](./user-guide.md) | Installation, first run, uncertainty, refresh/recovery, optional contribution, data, updates, and support |
| Architecture | [System architecture](./reference/system-architecture.md) | Current components, trust boundaries, stores, identities, and data flow |
| Privacy | [Local data, network, and privacy](./reference/local-data-and-privacy.md) | Exact source reads, local and hosted stores, Keychain, network, retention, deletion, and uninstall boundaries |
| Hosted erasure | [Self-service deletion retirement](./decisions/2026-08-30-self-service-deletion-retirement.md) | Accepted source contract: confirmed device disconnect, private owner erasure, and retained restore safeguards; not deployment evidence |
| Calibration semantics | [Composition-aware expected-line contract](./design/composition-aware-expected-line.md) | Maintained model-mix, saturation, reset, and lineage carry-forward interpretation; not a provider capacity claim |
| APIs | [API and integration surface](./reference/api-surface.md) | Stable entry point for the source-checked HTTP, native, process, package, schema, binding, and external-service inventory |
| Detailed API inventory | [Source-backed API surface reference](./reference/2026-08-26-api-surface-reference.md) | Complete inventory maintained with source-parity tests; implemented source is not deployment or release proof |
| Commands | [Command-line reference](./reference/cli-reference.md) | Source-checked `usage-monitor` command inventory and safety classes |
| Schemas | [Schema and contract lifecycle](./reference/schema-contracts.md) | Canonical owners, mirrors, generators, versioning, and retirement |
| Local index | [Unified local index schema](./reference/unified-index-schema.md) | Current schema family, physical/parser versions, tables, generation, and migration rules; includes the accepted schema-11 cleanup indexes |
| Local recovery | [Unified index preservation and recovery](./runbooks/unified-index-recovery.md) | Preservation-first diagnosis and candidate rebuild; never relabel or destroy the only index |
| Sidebar recovery | [Collapsed dashboard sidebar rescue](./runbooks/sidebar-stranded-collapsed-rescue.md) | Current 0.1.16 recovery for persisted collapsed navigation; removes only exact window-geometry defaults |
| Platform support | [Platform support and qualification](./reference/platform-support.md) | macOS support and the evidence ladder Windows/Linux must satisfy before any claim |
| Production | [Production service operations](./runbooks/production-operations.md) | Read-only observation, deploy/migration gates, private owner erasure, containment, rollback, and recovery boundaries |
| Community diagnostics | [Community allowance-band diagnosis](./runbooks/2026-08-13-community-allowance-band-diagnosis.md) | Current fit-cache and aggregate diagnosis; production writes remain owner-run |
| Retired hosted APIs | [Hosted API retirement data gates](./runbooks/2026-08-27-hosted-api-retirement-data-gates.md) | Owner-run read-only D1 checks required before any future deletion of data retained after source-route retirement |
| Release verification | [Verify a TiboTattle release](./verify-release.md) | User-facing checksum, native trust, manifest, and evidence verification |
| Release trust | [Cross-platform release trust](./decisions/2026-08-18-cross-platform-release-trust.md) | Common evidence decision and artifact-specific native trust requirements |
| Release publication | [Cross-platform release publication](./runbooks/2026-08-18-cross-platform-release-publication.md) | Activation-gated multi-platform evidence and immutable publication order; not a support claim |
| macOS release | [macOS stable release](./runbooks/macos-stable-release-runbook.md) | Canonical build, signing, notarization, Sparkle, Homebrew, website, and GitHub release sequence |
| macOS distribution | [Homebrew distribution and macOS support](./decisions/2026-08-15-homebrew-distribution-and-macos-support.md) | First-party tap, uninstall boundary, and supported macOS floor |
| Public-site preview | [Public site local preview](./runbooks/2026-08-17-public-site-local-preview.md) | Maintained local rendering/inspection path; not deployment proof |
| Web-only release | [Web-only release](./runbooks/2026-08-17-web-only-release.md) | Maintained website publication lane and its release boundaries |
| Windows readiness | [Windows portability environments](./runbooks/2026-08-17-windows-portability-environments.md) | Development/qualification environments only; Windows remains unsupported |
| R7 evidence | [R7 release-evidence receipt maintenance](./runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md) | Staleness rule and protected dual-runtime regeneration; not a routine documentation check |

## Lifecycle evidence

The [API lifecycle review](./reviews/2026-08-26-api-lifecycle-review.md) records
the source-level removals merged in PR #78. It is an implementation record, not
an assertion that an installed release or deployed service has already adopted
those removals.

That review's preserved self-service deletion route is historical. The
[2026-08-30 decision](./decisions/2026-08-30-self-service-deletion-retirement.md)
subsequently retires it in source; it does not remove retention/restore
obligations or establish that the service or installed app has changed.

Documents not listed as authorities are records or supporting context, not
current operational instructions:

- **Decisions** remain only when the accepted contract still explains or
  constrains the current system.
- **Receipts and QA** prove only the exact checkout, command, environment,
  artifact, and date they name. Retain them only for an enduring release,
  recovery, compliance, or regression purpose.
- **Audits, reviews, investigations, research, and reports** remain only when
  their findings still have audit or recovery value.
- **Plans and goals** describe intended work, never implementation or release
  state. Delete completed, abandoned, or superseded plans after durable results
  are incorporated into code, tests, decisions, and maintained authorities.
- **Design records** remain only for durable product rationale; current
  implementation status comes from source and the authorities above.

Every retained dated Markdown record requires `title`, `date`, `type`, and
`status` frontmatter. Status `current`, `canonical`, `maintained`, or
`operational` is valid only for a document listed in this index.

## Maintenance workflow

1. Search every tracked file for affected document paths and basenames, including
   current authorities, READMEs, public docs, disclosures, templates, scripts,
   comments, fixtures, ignore files, and security allowlists.
2. Update code-derived documentation tests and generated mirrors with the
   source change.
3. Delete superseded prose and repair every inbound link; do not add an
   `archive` folder merely to avoid deletion.
4. Run `npm run docs:check` and `npm run test:preflight`, then the owning
   contract or release gate.
5. Re-read rendered Markdown and distinguish source, runtime, artifact, release,
   updater, and deployment claims before reporting completion.

The repository root [README.md](../README.md),
[CONTRIBUTING.md](../CONTRIBUTING.md), [SUPPORT.md](../SUPPORT.md), and
[SECURITY.md](../SECURITY.md) are the maintained public/developer entry points.
