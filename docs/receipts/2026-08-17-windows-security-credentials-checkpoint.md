---
title: Windows security and production credentials checkpoint
date: 2026-08-17
type: review
status: qualified
---

# Windows security and production credentials checkpoint

## Claim

This checkpoint advances the dormant Windows x64 filesystem and Credential
Manager adapters with handle-relative traversal, replacement, binding-integrity,
and in-process lease contracts. It also hardens the manual native qualification
lane. Windows production selectors remain fail-closed. This is not a Windows
support or Windows production-readiness claim.

## Source boundary

- Branch: `codex/windows-security-credentials`
- Prior checkpoint revision: `c40ba7c`
- Native-qualified implementation revision:
  `829d9cdfedfb79d307939757d28e948df3def6de`
- Checkpoint state: pushed task branch in an isolated worktree
- Pull request, merge, release, or installed product: no

## Implemented

- A fixed-capability Credential Manager adapter covers the four separate
  production credential namespaces without exposing them through the reviewed
  public platform API.
- A Windows x64 native filesystem binding and JavaScript adapter model
  handle-based identity, owner/DACL validation, reparse and hard-link refusal,
  secure creation, reopening, exact-handle deletion, and same-directory
  replacement.
- Component traversal uses `NtCreateFile` relative to held parent directory
  handles. Intermediate components use directory-safe access and `FILE_OPEN`,
  separately from final-file access and disposition.
- Newly created files/directories are removed on post-create policy failure.
  Replacement validates the post-rename name, identity, content, and canonical
  path, including long-name normalization for valid 8.3 spellings.
- The repository-owned binding requires a fixed sidecar manifest. The loader
  verifies byte count, SHA-256, contract, method set, and native claims before
  loading. The approved production policy remains false.
- Credential mutations require opaque leases tied to an exact frozen
  capability and operation. Duck-typed contexts, forged leases, hostile
  options, async audit callbacks, and malformed native values fail closed.
  The scoped lease API prevents manually stranded backend leases.
- Credential reporting is explicitly `qualification_only`,
  `crossProcessSafe: false`, `auditDurable: false`, and
  `productionSafe: false`.
- Participant identity has an injected Windows adapter seam and rejects an
  adapter unless it advertises both production and race safety.
- All Windows production selectors still reject the platform while surrounding
  state, lock, concurrency, and lifecycle paths remain unqualified.
- The manual Windows workflow builds the native binding from the exact requested
  revision. It compares an offline reinstall from a primed/restored store with
  an install from an explicitly empty store, and records whether restoration
  hit the GitHub cache.
- Native qualification selects one fixed 11-file test set, parses TAP aggregate
  counts without printing test output, and fails on every unexpected skip.
  It is restricted to GitHub Actions hosted qualification.

## Local evidence

- Combined native qualification manifest on macOS: 55 tests, 45 passed,
  0 failed, and 10 expected native-only skips.
- Complete portable lane: 983 tests, 973 passed, 0 failed, and 10 expected
  native-only skips, including preflight, documentation normalization, and
  the Windows portable contracts.
- macOS source lane: 42 passed, 0 failed, 3 artifact-only exclusions.
- Architecture boundaries: passed with 340 production files, 1,283 imports,
  and no approved debt edges.
- Root workspace hygiene, action syntax, documentation links, tool inventory,
  and `git diff --check`: passed.
- A full-root attempt reached 2,260 tests. After installing the Worker's
  existing locked dependencies, the only remaining failures were the two
  generated R7 release-evidence hash/count assertions. Those artifacts are
  deliberately not regenerated for an unqualified, unpublished Windows
  checkpoint.

These local checks prove portable behavior, macOS source closure, architecture
ownership, and deliberate Windows fail-closed behavior. Native Win32 evidence
is recorded separately below.

## Native Windows x64 evidence

- Manual workflow run:
  <https://github.com/adamallcock/tibotattle/actions/runs/32059277128>
- Exact revision: `829d9cdfedfb79d307939757d28e948df3def6de`.
- Result: both `warm` and `clean` jobs passed, including compilation, binding
  manifest verification, the complete portable lane, the fixed content-free
  security qualification, and the clean-checkout gate.
- Hosted environment: Microsoft Windows Server 2025 Datacenter
  `10.0.26100`, x64; runner image `windows-2025-vs2026`
  `20260810.198.2`; runner `2.336.0`.
- Toolchain: Node `v26.2.0`, Corepack `0.34.0`, pnpm `11.9.0`.
- Binding receipt: 322,560 bytes; SHA-256
  `12ea1d2c3e3bd9cc7e84d1b93401fba5834132278ad63778e4573084de9c65a2`.
- Native security selection: 11 fixed files, including 4 filesystem files and
  3 credential files. The 55 registered tests passed with 0 failures and
  0 skips; the qualification wrapper rejects any skipped test.
- Warm-store evidence: the GitHub cache missed, an online install primed the
  store, and the required offline reinstall passed. This proves offline reuse
  after priming, not restoration from a pre-existing GitHub cache entry.
- Clean-store evidence: installation and all qualification gates passed from
  an explicitly empty pnpm store.
- Credential and filesystem fixtures were disposable; the workflow's final
  tracked, staged, and untracked checkout checks all passed.

## Gates still open

- Replace the final destination check-then-rename window with an atomic
  compare-and-swap or an equivalently proven same-user exclusion primitive.
- Authenticate the built native binding through the packaging/signing chain
  and eliminate the remaining hash-then-load path replacement window.
- Add a named Win32 mutex or equivalent cross-process lease, plus durable audit
  semantics, around every
  production Credential Manager mutation.
- Move every associated metadata, observation, callback, contribution-device,
  and lock file onto the qualified Windows filesystem boundary.
- Run native adversarial DACL, junction, mount-point, hard-link, replacement,
  sharing, long-path, case-collision, restart, and upgrade-retention tests.
- Replace the pinned `actions/cache` revision before GitHub removes the
  currently forced Node 24 compatibility path; this warning did not affect the
  successful qualification result.

## Next permitted claim

The evidence in this checkpoint permits this narrower claim now:

> TiboTattle's dormant Windows x64 filesystem and Credential Manager adapters
> pass the fixed native qualification contract on clean and warm hosted
> Windows runners.

Production selectors remain disabled. The phrases "TiboTattle's production
Windows credential layer is ready" and "TiboTattle supports Windows" remain
out of scope.
