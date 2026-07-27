---
title: Clean-Clone Local Review Artifact Verification Receipt
date: 2026-07-26
type: verification-receipt
status: complete
---

# Clean-Clone Local Review Artifact Verification Receipt

## Verdict

The exact private-remote commit
`eeebdf6b29a5b8295f15cac25542f465f6819212` was cloned into a new owner-only
temporary directory, installed only from the checked-in lockfiles, tested,
and built without using the working checkout's dependency tree or generated
state.

The fresh checkout remained Git-clean after installation and verification.
Two local-review artifact builds from that clone were byte-identical. The
result passed the complete 12-command isolated-home lifecycle both with macOS
network denial and without denial. This closes the clean-clone reproducibility
part of G0/G1 for the declared macOS arm64 engineering candidate.

It does not close signing, notarization, genuine clean-machine, consent,
volunteer-review, or resource-ceiling gates.

## Reproducibility defect found and fixed

The first remote-clone rehearsal exposed an honest packaging defect. The
repository used `ignore-workspace=true` to avoid inheriting an unrelated pnpm
workspace from the operator's home directory, but did not provide its own
workspace policy. A fresh `pnpm install --frozen-lockfile` therefore generated
an untracked `pnpm-workspace.yaml`, and the artifact correctly recorded
`workingTree: dirty`.

The repository now supplies its own `pnpm-workspace.yaml`, explicitly denies
the `@github/keytar` lifecycle build, and uses the already packaged,
digest-pinned Darwin arm64 prebuild. The obsolete `.npmrc` escape hatch was
removed. A second clone from the pushed fixed commit installed without
generating or modifying any tracked or untracked file.

The clean install loaded the Keytar prebuild successfully. Its SHA-256 was
`855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a`.

## Exact artifact

| Field | Value |
|---|---|
| Artifact | `usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64.tar` |
| Source commit | `eeebdf6b29a5b8295f15cac25542f465f6819212` |
| `SOURCE_DATE_EPOCH` | `1785114219` |
| Archive bytes | `146447872` |
| Archive SHA-256 | `6d0be2d7f9aa3367d0169eb4598c003058c491348854ea4a0113ae5a3407dc87` |
| Manifest SHA-256 | `9e91d770d47e7736485a9c2d0a434569dd3c1b60d74d5199b016f531bff8e223` |
| Native audit library SHA-256 | `f5812e097ddc577169df67451aaa63ad0926b0587456cb04b5e0223bb4b15dfa` |
| Platform/runtime | macOS arm64 / Node 26.2.0 |
| Signing/notarization | Unsigned / not notarized |
| External participants authorized | No |

The retained local engineering candidate is under `.release-repro/f/`.

## Clean-clone installation evidence

- Root install: `corepack pnpm install --frozen-lockfile`
- Root dependency tree: 12 packages from `pnpm-lock.yaml`
- Worker install: `npm ci`
- Worker dependency tree: 86 packages from `apps/worker/package-lock.json`
- Worker audit: zero reported vulnerabilities
- Post-install Git status: clean and equal to the private remote branch
- Keytar lifecycle execution: denied by repository policy
- Keytar packaged Darwin arm64 prebuild: load passed

## Clean-clone tests

The supported serial repository command passed 895 of 895 tests.

The complete product gate passed:

- 28 of 28 web UI and browser-contract tests;
- 41 of 41 local companion, prepared-contribution, device-sync, queue, and
  foreground-watch tests;
- generated Worker types and TypeScript checks;
- 30 of 30 operator/staging-script tests;
- 65 of 65 Worker runtime tests;
- default Worker deployment dry run; and
- contained staging deployment dry run.

The staging projection remained `safe_unprovisioned` with collection
unauthorized.

## Artifact and network-attempt verification

Two clean-clone builds produced the same 146,447,872-byte archive SHA-256
`6d0be2d7f9aa3367d0169eb4598c003058c491348854ea4a0113ae5a3407dc87`
and the same manifest SHA-256
`9e91d770d47e7736485a9c2d0a434569dd3c1b60d74d5199b016f531bff8e223`.

The complete command sequence—inspect, install, doctor, inspect export, export
bundle, verify bundle, materialize export set, verify export set, deletion
preflight and confirmation, uninstall preflight and confirmation—passed twice.

| Environment | Commands | Covered JavaScript attempts | Covered native libc attempts | Private canary hits |
|---|---:|---:|---:|---:|
| macOS deny-network sandbox | 12 | 0 | 0 | 0 |
| Network permitted | 12 | 0 | 0 | 0 |

Ordinary uninstall preserved the participant identity. The attempt-telemetry
boundary remains unchanged: direct machine-code syscall instructions, QUIC
frameworks, and non-Node child processes are not measured.

## Signing readiness

The non-mutating signing preflight passed against the exact archive and
manifest. The technical signing path is ready, but the state remains
`owner_authorization_required` with:

1. `OWNER_SIGNING_AUTHORIZATION_REQUIRED`;
2. `NOTARY_CREDENTIAL_NOT_VERIFIED`; and
3. `SIGNED_SUCCESSOR_NOT_BUILT`.

No signing or notary credential was used. External participants remain
unauthorized.

