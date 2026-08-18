---
title: Four-day Windows readiness milestone
date: 2026-08-17
type: goal
status: complete-portable-core-qualified
---

# Four-day Windows readiness milestone

## Outcome

Spend four engineering days reducing the uncertainty and future cost of
Windows 11 x64 support without claiming that TiboTattle supports Windows.
The milestone establishes a repeatable portable-core lane, exercises that lane
on macOS, a network-isolated Linux container, and native Windows x64, and
records every known place where Windows needs a security or behavioral
equivalent rather than a skipped POSIX assertion.

This is a bounded prerequisite for [Windows issue #3](https://github.com/adamallcock/tibotattle/issues/3).
It does not build a desktop shell, installer, updater, or production Windows
credential backend. The task branch was pushed only after explicit
authorization; no pull request, merge, issue comment, release, or artifact
publication was authorized.

## Four-day allocation

### Day 1: inventory and deterministic portable lane

- Create an isolated task worktree from the current integration branch.
- Inventory platform assumptions in runtime code, tests, native modules,
  packaging, process lifecycle, storage, and credentials.
- Define an explicit, reviewed portable-test manifest. Avoid a negative
  “everything except macOS” glob whose scope can drift silently.
- Add a source-controlled ledger for every `win32` branch in that manifest,
  including branch count, classification, and required Windows follow-up.
- Add a test that fails when a Windows branch appears, disappears, or changes
  count without a ledger update.
- Repair only small portability defects discovered by the lane. Preserve the
  production fail-closed identity boundary.

### Day 2: repeatable environments and native-Windows canary

- Add a pinned Debian Bookworm container with Node 26.2.0, Corepack 0.34.0,
  pnpm 11.9.0, locked dependencies, no runtime network, and an internal
  synthetic Git baseline for repository-integrity tests.
- Add an owner-triggered GitHub Actions workflow on `windows-2025` with pinned
  action revisions, read-only repository permission, locked installation, an
  environment receipt, portable tests, and a tracked-file cleanliness check.
- Make the Windows workflow capable of one normal-cache run and one clean-cache
  run. Neither run is optional for milestone completion.
- Install and record a local Windows virtualization path where practical. A
  Windows-on-ARM guest may help development but does not replace the native
  Windows x64 workflow.

### Day 3: Windows contracts and real process behavior

- Add deterministic `win32` path tests for drive roots, backslashes, Unicode,
  spaces, default and custom `CODEX_HOME`, and temporary state cleanup.
- Add a real-process companion smoke test using only synthetic session data.
  It must bind loopback on an ephemeral port, expose health and local analysis,
  prove that content and paths do not enter browser-visible output, stop on
  request, leave no child process, and remove temporary state.
- Exercise abnormal parent disappearance and require bounded orphan recovery.
- Write an explicit Windows filesystem-security contract for owner/DACL checks,
  reparse points, handle identity, hard links, and fail-closed behavior.

### Day 4: bounded Credential Manager probe and qualification receipt

- Load only the reviewed Windows x64 `@github/keytar` binding and verify its
  exact SHA-256 before use.
- On native Windows x64, create a random disposable generic credential, read it
  back, delete it, confirm deletion, and emit only content-free status fields.
- Do not connect the probe to any production identity or credential capability.
- Run the portable lane on macOS and Linux, then run native Windows x64 twice,
  including a clean dependency-cache run.
- Record exact revisions, runner image/version, runtime versions, commands,
  pass/skip/failure counts, container digest, native-binding digest, and open
  gaps in a dated receipt.
- Prepare, but do not post, a concise update for Windows issue #3.

## Environment matrix

| Environment | Purpose | Authority |
|---|---|---|
| macOS arm64 host | Development, portable regression, existing product regression | Authoritative for the current Mac product only |
| Pinned Linux container on Colima | Detect POSIX portability defects and prove network-independent synthetic tests | Portable-core evidence; not Windows evidence |
| GitHub-hosted `windows-2025` x64 | Native filesystem, process, path, and Credential Manager qualification | Authoritative for this Windows-readiness milestone |
| Local UTM with Windows 11 ARM | Optional interactive development and debugging | Non-authoritative for Windows x64 support |

See the [environment runbook](../runbooks/2026-08-17-windows-portability-environments.md)
for exact commands and restoration instructions.

## Privacy and safety constraints

- Use synthetic Codex fixtures and randomly generated disposable credentials
  only. Do not read or copy the maintainer's real Codex, Claude, or credential
  state into a container or hosted runner.
- Run the Linux qualification with `--network none`.
- Keep GitHub workflow permissions at `contents: read`.
- Never print a credential value, prompt, response, user path, raw account ID,
  or session content in a receipt.
- Production identity and contribution credentials continue to reject Windows.
- Do not publish, merge, buy media or activation, or create a release artifact
  without separate explicit authorization. The temporary task-branch push
  authorization did not broaden those boundaries.

## Acceptance criteria

- [x] Work is isolated from the maintainer's dirty checkout.
- [x] An explicit portable manifest and drift-detecting Windows branch ledger
  exist.
- [x] A pinned, offline-at-runtime Linux environment exists.
- [x] An owner-triggered native Windows x64 workflow exists.
- [x] Windows path contracts and a synthetic real-process companion smoke exist.
- [x] A hash-pinned, content-free Windows Credential Manager probe exists and
  production credentials remain untouched.
- [x] UTM is installed and the absence of a local Windows guest is documented.
- [x] The complete portable lane passes on macOS: 930 passed and the two
  native-Windows-only checks skipped.
- [x] The complete portable lane passes in the pinned Linux container: 930
  passed and the same two native-Windows-only checks skipped.
- [x] Relevant existing macOS product lanes pass: source/configuration and the
  development-only launcher build smoke are green.
- [x] Native Windows x64 passes twice on the same revision, once with a clean
  dependency cache.
- [x] The native Credential Manager round trip passes and cleanup is confirmed.
- [x] The final receipt contains no unexplained skips or failures.
- [x] The issue #3 update is ready for maintainer review but is not posted.

## Stop conditions

Stop and keep this goal open if native Windows cannot run, the Credential
Manager cleanup cannot be confirmed, a portable regression remains
unexplained, the workflow has to access real user data, or an action would
cross the separate push/publication boundary. A Linux or simulated-win32 pass
cannot satisfy a native Windows checkbox.

## Completion statement

On completion, the permitted claim is: “TiboTattle's selected portable core
passed a documented macOS, Linux, and native Windows x64 qualification, and a
disposable Credential Manager probe passed.” The prohibited claim remains:
“TiboTattle supports Windows.” Full support still requires the shell,
production credential backend, adversarial filesystem security, packaging,
signing, installation, upgrade, and uninstall gates in issue #3.
