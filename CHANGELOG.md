# Changelog

Notable user-facing changes to TiboTattle are recorded here, newest first. The
layout keeps an explicit `Unreleased` boundary and uses SemVer-compatible
version labels; it does not imply API stability before 1.0.

## Provenance and acknowledgements

- A release heading links to its checked-in notes. The date is the UTC calendar
  date on which the public GitHub Release was published.
- Every released entry links to the public GitHub Release, its exact source
  revision, and the comparison with the preceding release source. Stable tags
  are annotated except for the protected historical v0.1.10 anomaly recorded
  below. The GitHub Release remains canonical for published artifacts and
  release evidence.
- Pull-request and issue links provide review and attribution context. They do
  not imply that an issue was closed or that a source-only change shipped in an
  installed build; open or source-only boundaries are stated explicitly.
- The v0.1.0-v0.1.12 notes were backfilled from their published GitHub Release
  bodies on 2026-08-23. Their body text is verbatim, with only a conventional
  terminal newline normalized for checked-in Markdown; no retrospective claims
  were added. Existing v0.1.13-v0.1.16 notes were left unchanged.
- Releases v0.1.13 and later publish a DMG together with an appcast, release
  manifest, `SHA256SUMS`, and a verification guide. Earlier release pages
  preserve the DMG that was actually published at the time.

Thanks to the early pilot users who shared observations and reproduction steps.
To preserve privacy and avoid invented attribution, people are named here only
when a public issue, pull request, or explicit consent supports the credit.
Special thanks to [Dependabot](https://github.com/apps/dependabot) for the
dependency maintenance merged in [PR #20](https://github.com/adamallcock/tibotattle/pull/20).
Tool-assisted co-authorship is recorded in Git commit trailers; the maintainer
remains accountable for release wording, validation, signing, and publication.

## [Unreleased]

Future changes will be recorded here.

## [0.1.17](./release-notes/0.1.17.md) - 2026-09-03

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.17) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.17) ·
[changes since v0.1.16](https://github.com/adamallcock/tibotattle/compare/v0.1.16...v0.1.17) ·
[accepted runtime basis](https://github.com/adamallcock/tibotattle/commit/394c8a03a986e0daadbe662679fd002202682e44)

Stable product build `1024` uses accepted runtime basis
`394c8a03a986e0daadbe662679fd002202682e44`; internal RC9 `1023.7` was the
preceding dogfood allocation. PR #94 outcome is `passed_with_historical_artifact_refusal`; see the
[qualification receipt](./docs/receipts/2026-09-03-pr94-account-plan-attribution-qualification.md).
The manual clean-profile and physical Login Item matrix remains deferred; see
the [native release plan](./docs/plans/2026-09-03-public-0.1.17-release.md).
Hosted migrations and device pairing are not activated by the desktop release.

This entry combines direct post-v0.1.16 work with reviewed merges in [PR #80](https://github.com/adamallcock/tibotattle/pull/80),
[PR #83](https://github.com/adamallcock/tibotattle/pull/83),
[PR #84](https://github.com/adamallcock/tibotattle/pull/84),
[PR #85](https://github.com/adamallcock/tibotattle/pull/85),
[PR #86](https://github.com/adamallcock/tibotattle/pull/86),
[PR #87](https://github.com/adamallcock/tibotattle/pull/87),
[PR #88](https://github.com/adamallcock/tibotattle/pull/88),
[PR #89](https://github.com/adamallcock/tibotattle/pull/89),
[PR #90](https://github.com/adamallcock/tibotattle/pull/90),
[PR #92](https://github.com/adamallcock/tibotattle/pull/92),
[PR #94](https://github.com/adamallcock/tibotattle/pull/94),
[PR #95](https://github.com/adamallcock/tibotattle/pull/95), and
[PR #96](https://github.com/adamallcock/tibotattle/pull/96).
PRs #73 and #74 are not part of this native macOS release. PR #75 is not
merged wholesale; a native subset of its menu-bar and weekly-pace work is
ported without its Electron or multi-root changes. The release does not
include the Electron application or unfinished Claude Code usage-monitoring
integration; 0.1.17 does not collect, display, or claim Claude Code usage.
The [merged-main comparison](https://github.com/adamallcock/tibotattle/compare/v0.1.16...main)
provides public branch-history context; PR links identify reviewed merges, while
unlinked items are direct commits.

### Added

- Adds admin metrics history with daily sparklines, 24-hour deltas, cached
  history, allowance lineage, plan cohort filters, and alert controls
  ([PR #67](https://github.com/adamallcock/tibotattle/pull/67),
  [PR #68](https://github.com/adamallcock/tibotattle/pull/68)).
- Adds a dedicated admin Plan cohorts card with current headcount and measured
  allowance capacity per plan, plus plan-scoped merge previews
  ([PR #67](https://github.com/adamallcock/tibotattle/pull/67),
  [PR #68](https://github.com/adamallcock/tibotattle/pull/68)).
- Adds native progress and boot-state feedback while the local dashboard becomes
  ready ([PR #58](https://github.com/adamallcock/tibotattle/pull/58),
  [PR #59](https://github.com/adamallcock/tibotattle/pull/59)).
- Adds the Forest Ink dark appearance with System, Light, and Dark preferences
  ([PR #62](https://github.com/adamallcock/tibotattle/pull/62)).
- Adds a cache-reuse outcome view that distinguishes warm, switched, and
  post-compaction behavior ([PR #64](https://github.com/adamallcock/tibotattle/pull/64)).
- Adds a merged public community-allowance homepage and a compact platform
  download selector, while keeping unsupported platform boundaries explicit
  ([PR #70](https://github.com/adamallcock/tibotattle/pull/70),
  [PR #72](https://github.com/adamallcock/tibotattle/pull/72)).
- Adds source-backed human-readable Codex plan and quota-window names plus a
  drift ledger and CI check ([PR #71](https://github.com/adamallcock/tibotattle/pull/71)).
- Adds progressive repository agent guidance with scoped instructions and
  machine-checked architecture ownership
  ([PR #77](https://github.com/adamallcock/tibotattle/pull/77)).
- Adds maintained architecture, privacy/data, API, CLI, schema, platform,
  operations, recovery, status, and user documentation; removes superseded
  planning and status prose from the active tree.
- Adds a native left-click menu-bar popover with current Five-hour and seven-day
  allowance lanes, fail-closed 7/30-day usage history, and a weekly pace outlook;
  right-click and Control-click retain the native actions menu. The complete
  instrument now remains reachable through vertical scrolling when two quota
  lanes exceed the height available below the status item (native subset of
  [PR #75](https://github.com/adamallcock/tibotattle/pull/75)).
- Adds transient local thread-name links to both recent cache-drop tables,
  including separate parent and worker links when that relationship is recorded.
  Missing attribution stays unlinked; names and links do not enter persisted
  accounting, exports, diagnostics, or hosted contribution
  ([PR #87](https://github.com/adamallcock/tibotattle/pull/87)).
- Adds an admin-only **By model** allowance view for Sol, Terra, Luna, and
  GPT-5.5, using the existing Pro-20x normalization and refusing the model band
  when identification or percentile evidence is incomplete. This source needs
  Worker migration 0041, deployment, warming, and real cohort data before the
  hosted view is operational; installing the desktop app does not activate it
  ([PR #89](https://github.com/adamallcock/tibotattle/pull/89)).

### Changed

- Declares external participation accurately in production and removes two
  retired admin cards that permanently reported zero.
- Bounds the resident legacy archive projection independently from the
  short-lived rebuild process, avoiding an inherited multi-gigabyte memory
  allowance during fallback accounting
  ([PR #49](https://github.com/adamallcock/tibotattle/pull/49)).
- Supports Codex's valid paginated and reverted multi-rollout thread lineage
  without dropping or double-counting retained history
  ([PR #65](https://github.com/adamallcock/tibotattle/pull/65)).
- Keeps new or unreviewed Codex thread-source labels privacy-safe and adds the
  selected Codex binary and version to `usage-monitor doctor`
  ([PR #69](https://github.com/adamallcock/tibotattle/pull/69)).
- Synchronizes Codex plan and quota contracts, including human-readable plan
  names, the Five-hour allowance label, and distinct observed quota pools
  ([PR #71](https://github.com/adamallcock/tibotattle/pull/71)).
- Uses event-time Standard API prices and published Priority/Fast price ratios
  for speed-priced API-equivalent accounting where available. Disclosed pricing
  assumptions and unknown speed modes remain explicit; this is a comparison
  measure, not a bill or a claimed subscription quota formula
  ([PR #80](https://github.com/adamallcock/tibotattle/pull/80)).
- Compacts accounting presentation with one headline amount, partial-estimate
  explanations for covered overhead, a shorter Configuration label, and API
  equivalent table headings whose help retains the Standard-rate basis. The
  cache-continuity table drops the Estimated lost reuse column without changing
  the underlying calculation.
- Aligns full-history headline and timeline input-context pricing with the
  accounting cache's existing compatibility rule, fixing differing API
  equivalents for the same older usage without changing token totals.
- Keeps current-plan and historical-plan local estimates, history, comparison
  ranges, forecasts, and share cards on the same selected plan-era population.
  Missing or conflicting account/plan evidence remains unavailable instead of
  borrowing another era or claiming account-exact, cross-device, or
  provider-authoritative billing attribution
  ([PR #94](https://github.com/adamallcock/tibotattle/pull/94)).
- Adds the closed telemetry v1.1 account/plan transport and lifecycle as staged
  source only. Worker migrations 0042-0044, hosted activation, and a new explicit
  consent are separate gates; a desktop install does not deploy the protocol or
  alter an existing contribution consent
  ([PR #94](https://github.com/adamallcock/tibotattle/pull/94)).
- Replaces self-service hosted-delete controls with confirmed **Disconnect this
  Mac**. Disconnect durably pauses this Mac's contribution delivery without
  deleting hosted history, local analysis, or other devices; signing out is a
  separate action ([PR #86](https://github.com/adamallcock/tibotattle/pull/86)).
- Retires `DELETE /api/v1/me` in Worker source while preserving private owner
  erasure, hosted export, local erase, and deletion-safe restore safeguards.
  This Worker change is not deployed by the desktop release. Hosted cutover
  still requires owner-operation preflight, private privacy-request intake and
  identity verification, and verified retention/backup disclosures; no retention
  policy change or erasure completion is implied
  ([PR #86](https://github.com/adamallcock/tibotattle/pull/86)).
- Completes the API lifecycle cleanup by removing the retired Cloud Run/GCS
  experiment, unused hosted and loopback surfaces, the inactive automatic
  contribution scheduler, and the unfinished Claude quota route while retaining
  the reviewed local-native, Worker, export, and direct-report boundaries
  ([PR #78](https://github.com/adamallcock/tibotattle/pull/78)).
- Recognizes the schema-8 index shipped by 0.1.16 and supported pre-release
  schema-9 state after a read-only compatibility preflight, then rebuilds a
  schema-11 stage from readable raw history because those formats predate the
  current source-identity contract. A schema-10 index instead receives the
  additive schema-11 cleanup indexes on a staged copy. The independent parser
  v10-to-v11 upgrade still reprocesses readable sources; an unchanged source is
  reusable only when its parser and source provenance are current. Neither path
  replaces the live index until validation succeeds. This build refuses a newer
  schema before mutation and reports it as unavailable rather than empty.
- Makes the rollback boundary explicit: after migration to schema 10 or 11, do
  not reopen the index with 0.1.16. That shipped binary lacks the typed read-only
  refusal and may touch SQLite journal mode before rejecting the schema.
- Persists the last authoritative dashboard snapshot across launch, keeping
  verified retained figures visible and labelled while fresh analysis advances.
- Moves macOS unified-index work off the loopback event loop, uses the existing
  bounded parallel rebuild for a missing index, and forwards strict content-free
  file progress so health, status, and cancellation remain responsive during a
  large first pass.
- Releases the native readiness gate after the primary dashboard render instead
  of waiting for every secondary load ([PR #60](https://github.com/adamallcock/tibotattle/pull/60)).
- Makes Codex `thread_source` a compatibility and attribution signal without
  treating it as usage or cost evidence
  ([PR #69](https://github.com/adamallcock/tibotattle/pull/69)).
- Establishes a provenance-backed changelog and checked release-note contract
  ([PR #66](https://github.com/adamallcock/tibotattle/pull/66)).
- Retires the unused Cloud Run experiment, legacy hosted account routes, and
  the shipping Claude Desktop plan-history path; adds a source-checked API
  lifecycle reference for the remaining interfaces
  ([PR #78](https://github.com/adamallcock/tibotattle/pull/78)).

### Fixed

- Keeps the macOS dashboard sidebar recoverable through a toolbar button, View
  menu command, keyboard shortcut, and one-time rescue for affected installs
  ([PR #57](https://github.com/adamallcock/tibotattle/pull/57)).
- Replaces misleading loading warnings when retained figures remain visible
  during a recalculation.
- Retains valid usage, tool, and quota facts when one provider quota window is
  malformed, while withholding that invalid observation with an explicit
  diagnostic rather than presenting it as zero.
- Withholds orphaned inline-fork usage when the parent history needed to prove
  replay suppression is unavailable, including in the legacy collector, instead
  of charging inherited history as fresh usage
  ([PR #83](https://github.com/adamallcock/tibotattle/pull/83)).
- Restores readable dark-mode contrast in cache-reuse tooltips
  ([PR #84](https://github.com/adamallcock/tibotattle/pull/84)).
- Removes the internal partial-tool-history warning from the dashboard without
  changing the underlying coverage state or inventing missing tool totals
  ([PR #85](https://github.com/adamallcock/tibotattle/pull/85)).
- Accepts a selected paginated Codex replacement that begins a new segment
  without `history_base`, and clears the replaced lineage snapshot set before
  later forks are evaluated.
- Presents verified partial history as a quieter coverage limitation and keeps
  the compact toolbar badge separate from the in-page progress panel; hard
  refresh failures retain the error treatment.
- Defers cleanup of a source rejected late in a fresh rebuild until the required
  indexes exist, preventing repeated full-table scans from consuming the cold
  build's safety window.
- Replaces the unconditional “Headline ready” refresh claim with neutral local
  summary/progress copy, and keeps native and browser polling attached through
  the bounded fresh-index build window.
- Retries compatible legacy Keychain reads non-interactively up to three times
  and reserves the explained approval fallback for an explicit Settings action.
  Automatic launch, refresh, contribution, and migration paths remain
  prompt-free; an unexpected security prompt blocks release qualification
  ([PR #95](https://github.com/adamallcock/tibotattle/pull/95)).
- Recovers the native dashboard when readiness arrives after the initial wait:
  startup uses the bounded primary projection, fences stale generations, keeps
  the slow-load page alive, and replaces a prior timeout after the late primary
  render succeeds ([PR #96](https://github.com/adamallcock/tibotattle/pull/96)).
- Keeps cancellation and timeout terminal handling from starting another full
  data-store reload, preserves the last published generation, and reclaims only
  old, exactly identified abandoned staging files on a later safe retry.
- Prevents network-path requests from turning the canonical-host redirect into
  an external redirect.
- Opens the Share card from its macOS toolbar control
  ([PR #53](https://github.com/adamallcock/tibotattle/pull/53)).
- Distinguishes offline update checks from unavailable update infrastructure
  ([PR #54](https://github.com/adamallcock/tibotattle/pull/54)).
- Keeps the latest measured allowance visible in the menu bar during refresh
  ([PR #55](https://github.com/adamallcock/tibotattle/pull/55)).
- Keeps compatible, previously validated native usage history visible during
  refresh with retained-data labelling; missing or incompatible evidence remains
  unavailable rather than being presented as fresh. The native popover also
  dismisses on an outside click
  ([PR #88](https://github.com/adamallcock/tibotattle/pull/88)).
- Disables unused native window tabbing and hardens context-menu behavior
  ([PR #56](https://github.com/adamallcock/tibotattle/pull/56),
  [PR #61](https://github.com/adamallcock/tibotattle/pull/61)).
- Gives native dashboard startup failures phase-specific, actionable diagnostics
  ([PR #63](https://github.com/adamallcock/tibotattle/pull/63)).
- Hardens paginated Codex rollout discovery and ingestion so generations,
  checkpoints, truncation, and partial pages remain replay-safe
  ([PR #65](https://github.com/adamallcock/tibotattle/pull/65)).
- Gives the resident archive accounting projection its own memory ceiling
  ([PR #49](https://github.com/adamallcock/tibotattle/pull/49)).
- Top-aligns the homepage comparison graph with its title across platform-tab
  changes ([PR #76](https://github.com/adamallcock/tibotattle/pull/76)).

### Release tooling

- Updates the root schema-validation dependency `fast-uri` to patched 3.1.6.
- Verifies that the rendered social preview is the exact asset selected for the
  release ([PR #52](https://github.com/adamallcock/tibotattle/pull/52)).
- Adds checked-in, provenance-linked release notes and changelog validation
  ([PR #66](https://github.com/adamallcock/tibotattle/pull/66)).
- Adds a release-gated drift check for the reviewed Codex plan and quota
  contracts ([PR #71](https://github.com/adamallcock/tibotattle/pull/71)).
- Adds an explicit copy-first prepare/apply recovery path for a local unified
  index that cannot be migrated normally; recovery validates an isolated copy
  before any replacement is offered.
- Gives Preview its own app, bundle, semantic-open, local-state, Keychain,
  preferences, and Sparkle-feed identities, preventing preview installation or
  updates from replacing stable state.
- Records the stable build-1024 release allocation and accepted runtime basis
  `394c8a03a986e0daadbe662679fd002202682e44`; internal RC9 build `1023.7` was
  the preceding dogfood allocation. Signed tooling requires a clean checkout
  with exactly one matching annotated channel tag at `HEAD` before it can
  proceed. The release retains the fail-closed source, generation, resource,
  validation, atomic-publication, selected-plan Trends, and snapshot safeguards.
  PR #94 outcome is `passed_with_historical_artifact_refusal` in the [qualification
  receipt](./docs/receipts/2026-09-03-pr94-account-plan-attribution-qualification.md).
- Establishes scoped, machine-checked repository guidance for coding agents and
  the root layout they may extend
  ([PR #77](https://github.com/adamallcock/tibotattle/pull/77)).

### Related open issues

These are tracking references, not completed release items:

- Dark appearance source is merged in PR #62, but the signed-client release gate
  remains pending in [issue #11](https://github.com/adamallcock/tibotattle/issues/11).
- [PR #12](https://github.com/adamallcock/tibotattle/pull/12) integrated
  source-only Windows portability and credential-security foundations before
  v0.1.13, but production support remained disabled. Windows and Ubuntu desktop
  support remain open in [issue #3](https://github.com/adamallcock/tibotattle/issues/3)
  and [issue #4](https://github.com/adamallcock/tibotattle/issues/4).
- Multiple Codex roots for Windows plus WSL remain open in
  [issue #51](https://github.com/adamallcock/tibotattle/issues/51).

## [0.1.16](./release-notes/0.1.16.md) - 2026-08-21

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.16) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.16) ·
[changes since v0.1.15](https://github.com/adamallcock/tibotattle/compare/v0.1.15...v0.1.16)

- Keeps charts and cost figures visible through recalculation windows while
  preserving honest staleness status.

## [0.1.15](./release-notes/0.1.15.md) - 2026-08-21

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.15) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.15) ·
[changes since v0.1.14](https://github.com/adamallcock/tibotattle/compare/v0.1.14...v0.1.15)

- Keeps usage totals and usage timelines visible during fast refresh passes.

**Reference:** [PR #50](https://github.com/adamallcock/tibotattle/pull/50).

## [0.1.14](./release-notes/0.1.14.md) - 2026-08-20

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.14) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.14) ·
[changes since v0.1.13](https://github.com/adamallcock/tibotattle/compare/v0.1.13...v0.1.14)

- Stops timeline charts blanking during refresh and bounds large-history
  accounting work for quota windows with unreadable reset times.

## [0.1.13](./release-notes/0.1.13.md) - 2026-08-20

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.13) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.13) ·
[changes since v0.1.12](https://github.com/adamallcock/tibotattle/compare/v0.1.12...v0.1.13)

- Repairs contribution setup, large-history accounting, quota notifications,
  and the first-install Keychain experience.

**Selected references:** contribution recovery
([PR #29](https://github.com/adamallcock/tibotattle/pull/29),
[PR #30](https://github.com/adamallcock/tibotattle/pull/30),
[PR #31](https://github.com/adamallcock/tibotattle/pull/31)); large-history
accounting ([PR #33](https://github.com/adamallcock/tibotattle/pull/33),
[PR #38](https://github.com/adamallcock/tibotattle/pull/38),
[PR #48](https://github.com/adamallcock/tibotattle/pull/48)); Keychain hardening
([PR #34](https://github.com/adamallcock/tibotattle/pull/34),
[PR #44](https://github.com/adamallcock/tibotattle/pull/44)); quota evidence
([PR #35](https://github.com/adamallcock/tibotattle/pull/35),
[PR #37](https://github.com/adamallcock/tibotattle/pull/37)).

## [0.1.12](./release-notes/0.1.12.md) - 2026-08-15

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.12) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.12) ·
[changes since v0.1.11](https://github.com/adamallcock/tibotattle/compare/v0.1.11...v0.1.12)

- Adds the supported first-party Homebrew install path and aligns support on
  macOS 14 for Apple silicon.

**Reference:** [PR #1](https://github.com/adamallcock/tibotattle/pull/1).

## [0.1.11](./release-notes/0.1.11.md) - 2026-08-13

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.11) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.11) ·
[changes since the v0.1.10 source commit](https://github.com/adamallcock/tibotattle/compare/151adec996c9a0f621819f89777ac5a05f1df8b6...v0.1.11)

- Makes contribution backfill recover from stalls, adds readable allowance
  chart details, and hardens the community estimate.

## [0.1.10](./release-notes/0.1.10.md) - 2026-08-12

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.10) ·
[source commit](https://github.com/adamallcock/tibotattle/commit/151adec996c9a0f621819f89777ac5a05f1df8b6) ·
[changes since v0.1.9](https://github.com/adamallcock/tibotattle/compare/v0.1.9...151adec996c9a0f621819f89777ac5a05f1df8b6)

**Historical tag anomaly:** the protected published `v0.1.10` ref is a legacy
lightweight tag that resolves to the v0.1.9 source commit
`3b3a852abad643095c296550a827ed448b3720fa`. The v0.1.10 version-bump source is
`151adec996c9a0f621819f89777ac5a05f1df8b6`, which the source and comparison
links above use without rewriting published tag history.

- Makes contribution backfill drain steadily and adds signed-update credential
  recovery.

## [0.1.9](./release-notes/0.1.9.md) - 2026-08-11

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.9) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.9) ·
[changes since v0.1.8](https://github.com/adamallcock/tibotattle/compare/v0.1.8...v0.1.9)

- Removes the pairing race between fresh enrollment and browser cookie storage.

## [0.1.8](./release-notes/0.1.8.md) - 2026-08-11

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.8) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.8) ·
[changes since v0.1.7](https://github.com/adamallcock/tibotattle/compare/v0.1.7...v0.1.8)

- Makes sign-in single-flight and durable across app updates and relaunches.

## [0.1.7](./release-notes/0.1.7.md) - 2026-08-11

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.7) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.7) ·
[changes since v0.1.6](https://github.com/adamallcock/tibotattle/compare/v0.1.6...v0.1.7)

- Hardens hosted sign-in and re-pairing, bounds allowance estimation memory,
  and polishes the Trends chart.

## [0.1.6](./release-notes/0.1.6.md) - 2026-08-11

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.6) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.6) ·
[changes since v0.1.5](https://github.com/adamallcock/tibotattle/compare/v0.1.5...v0.1.6)

- Recovers lost device credentials, keeps WebKit loopback connections alive,
  and adds accounting resource diagnostics.

## [0.1.5](./release-notes/0.1.5.md) - 2026-08-11

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.5) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.5) ·
[changes since v0.1.4](https://github.com/adamallcock/tibotattle/compare/v0.1.4...v0.1.5)

- Makes upload progress fail honestly, adds the menu-bar mark, and restores a
  memory-bounded allowance estimate.

## [0.1.4](./release-notes/0.1.4.md) - 2026-08-11

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.4) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.4) ·
[changes since v0.1.3](https://github.com/adamallcock/tibotattle/compare/v0.1.3...v0.1.4)

- Adds composition-aware estimation, restores full quota history, and improves
  dashboard recovery and evidence labels.

## [0.1.3](./release-notes/0.1.3.md) - 2026-08-10

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.3) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.3) ·
[changes since v0.1.2](https://github.com/adamallcock/tibotattle/compare/v0.1.2...v0.1.3)

- Keeps Keychain-bound uploads working across signed updates and adds visible
  credential repair.

## [0.1.2](./release-notes/0.1.2.md) - 2026-08-10

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.2) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.2) ·
[changes since v0.1.1](https://github.com/adamallcock/tibotattle/compare/v0.1.1...v0.1.2)

- Names incremental-sync failures and makes pending or stalled sync recoverable.

## [0.1.1](./release-notes/0.1.1.md) - 2026-08-10

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.1) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.1) ·
[changes since v0.1.0](https://github.com/adamallcock/tibotattle/compare/v0.1.0...v0.1.1)

- Increases the contribution backfill batch from 60 to 500 chunks per pass.

## [0.1.0](./release-notes/0.1.0.md) - 2026-08-10

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.0) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.0) ·
[source history through v0.1.0](https://github.com/adamallcock/tibotattle/commits/v0.1.0)

- First public release of the local-first macOS Codex usage and allowance
  monitor with optional anonymous community contribution.
