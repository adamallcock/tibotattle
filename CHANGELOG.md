# Changelog

Notable user-facing changes to TiboTattle are recorded here, newest first. The
layout keeps an explicit `Unreleased` boundary and uses SemVer-compatible
version labels; it does not imply API stability before 1.0.

## Provenance and acknowledgements

- A release heading links to its checked-in notes. The date is the UTC calendar
  date on which the public GitHub Release was published.
- Every released entry links to the public GitHub Release, the annotated source
  tag, and the exact comparison with the preceding stable tag. The GitHub
  Release remains canonical for published artifacts and release evidence.
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

This section combines direct post-v0.1.16 work with merged pull requests through
[PR #78](https://github.com/adamallcock/tibotattle/pull/78), audited against
`main` commit `52399658f28303f6af00259f921c2c46a881978f` on 2026-08-27. The
[merged-main comparison](https://github.com/adamallcock/tibotattle/compare/v0.1.16...main)
is the public branch-history view; PR links identify reviewed merges, while
unlinked items are direct commits. Nothing in this section is a
published-release claim.

### Added

- Adds admin metrics history with daily sparklines, 24-hour deltas, allowance
  lineage, and plan cohort filters
  ([PR #67](https://github.com/adamallcock/tibotattle/pull/67),
  [PR #68](https://github.com/adamallcock/tibotattle/pull/68)).
- Adds a dedicated admin Plan cohorts card with current headcount and measured
  allowance capacity per plan.
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

### Changed

- Declares external participation accurately in production and removes two
  retired admin cards that permanently reported zero.
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
- Prevents network-path requests from turning the canonical-host redirect into
  an external redirect.
- Opens the Share card from its macOS toolbar control
  ([PR #53](https://github.com/adamallcock/tibotattle/pull/53)).
- Distinguishes offline update checks from unavailable update infrastructure
  ([PR #54](https://github.com/adamallcock/tibotattle/pull/54)).
- Keeps the latest measured allowance visible in the menu bar during refresh
  ([PR #55](https://github.com/adamallcock/tibotattle/pull/55)).
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

- Verifies that the rendered social preview is the exact asset selected for the
  release ([PR #52](https://github.com/adamallcock/tibotattle/pull/52)).

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
[changes since v0.1.10](https://github.com/adamallcock/tibotattle/compare/v0.1.10...v0.1.11)

- Makes contribution backfill recover from stalls, adds readable allowance
  chart details, and hardens the community estimate.

## [0.1.10](./release-notes/0.1.10.md) - 2026-08-12

**Provenance:** [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.10) ·
[annotated source tag](https://github.com/adamallcock/tibotattle/tree/v0.1.10) ·
[changes since v0.1.9](https://github.com/adamallcock/tibotattle/compare/v0.1.9...v0.1.10)

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
