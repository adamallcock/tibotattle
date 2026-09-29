# Contributing to TiboTattle

Thanks for your interest in improving TiboTattle. This repository is the
source of truth for the local macOS app, the browser dashboard, and the
optional hosted contribution service. Contributions are welcome, but the
project's privacy boundaries and verification gates are non-negotiable, so
please read this page before opening an issue or pull request.

## Developer prerequisites

Just installing the app? Use the [installation instructions](README.md#install-macos-apple-silicon-or-intel)
for Apple silicon or Intel Macs. The published app bundles its runtime and does
not require the development tools below.

- **Node.js ≥ 22.13** for repository tooling and tests.
- **pnpm 11** (the repository sets `packageManager: pnpm@11.9.0`).
- **macOS and Xcode command-line tools** for packaging or installed-app
  qualification. Follow the pinned release host requirements in the
  [macOS release runbook](docs/runbooks/macos-stable-release-runbook.md).

## Developer setup

The root workspace uses pnpm; the Worker keeps its own npm lockfile. Install
both dependency sets:

```bash
pnpm install
npm --prefix apps/worker ci
```

## Verification gates

The authoritative complete repository gate is `npm run check`. It composes
root tests with architecture, Codex-contract, tool-inventory, documentation,
schema-mirror, UI, release-site, local companion, Worker, incoming
Sparkle transition, and local-review runtime checks. Installed-app qualification
requires separate macOS hosts and signed artifacts;
report an environment-blocked lane explicitly.

Use focused gates while iterating, then run the broadest applicable set before
sending a pull request:

```bash
npm test                       # core suite (serial by design)
npm run codex:contract:check   # checked-in Codex plan/name contract parity
npm run docs:check             # maintained docs, links, status, and current authority
npm run product:worker:check   # hosted-service worker checks
npm run product:macos:transition:test  # incoming Sparkle-to-Electron contracts
npm run architecture:check     # ownership/boundary enforcement
```

Report any unavailable installed-artifact or hardware gate separately from
the source and contract checks.

## Generated artifacts are never hand-edited

`generated/` and the contract artifacts under `contracts/` are produced by
generators and revalidated by tests. Do not edit them by hand, and do not
gitignore them. Regenerate via:

```bash
npm run telemetry:generate                  # telemetry contract artifacts
npm run benchmark:r7:release:regenerate     # R7 release evidence receipts
```

A pull request that hand-edits a generated file will fail the exact-set and
provenance tests.

## The hosted service and forks

The hosted community-aggregate service at [tibotattle.com](https://tibotattle.com)
is operated by the maintainer. The deploy scripts in this repository target
the owner's Cloudflare account; they will not work from a fork as-is. Forks
that want their own hosted service must provision their own Cloudflare
resources per `apps/worker/wrangler.jsonc`. Nothing in the local app requires
the hosted service: local analysis works fully offline.

Production writes to the owner's account (`wrangler deploy --env production`,
`wrangler d1 migrations apply --remote`, and any D1 `DELETE`/`UPDATE`) are an
owner action; read-only `wrangler d1 execute … --remote` is suitable for
inspection and cost profiling. Two facts are important before changing the
Worker:

- **`wrangler deploy` does not apply D1 migrations.** Run
  `wrangler d1 migrations apply` separately, or a schema-dependent change can
  ship without its required schema.
- A stale Wrangler OAuth token can return D1 write error `7403` while reads
  still succeed; `wrangler login` refreshes it.

Worker-side D1 query and deployment diagnostics are documented in the
[community allowance diagnosis runbook](docs/runbooks/2026-08-13-community-allowance-band-diagnosis.md).

## No session content in issues or pull requests

TiboTattle exists to keep coding-agent session content private. Keep it out
of this repository's issue tracker too: **never include prompts, model
responses, or real file paths from Codex sessions** in an issue, pull
request, commit message, or test fixture. Use the built-in diagnostics
(`npm run diagnose:dashboard`) and redacted or synthetic examples instead.

## Repository hygiene

The tracked root layout is an explicit allowlist enforced by
`scripts/check-root-workspace-hygiene.mjs` (run inside `npm test`). Adding a
new root-level file or directory is an intentional project-layout decision
and must update `ROOT_WORKSPACE_POLICY` in the same commit.

## Keep maintained documentation current

Undated READMEs and the maintained entries in `docs/README.md` are current
contracts, not historical notes. A behavior, interface, data-access, privacy,
route, command, storage, setting, platform, release, operations, or support
change must update or delete every affected root, component, public, and
maintained document in the same pull request.

Use `git rm` for obsolete instructions instead of leaving contradictory prose.
Retain a dated evidence document only when it has an enduring audit, recovery,
decision, or release reason and accurate title, date, type, and lifecycle
status. Update the source-derived documentation tests with the same change.
