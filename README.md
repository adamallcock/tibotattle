# TiboTattle

Privacy-first, local-only monitoring for coding-agent usage. TiboTattle
reads the session metadata that Codex already stores on your Mac, reconstructs
your usage at standard API prices, and compares it with the quota movement your
provider reports — so you can see where your allowance stands, what a week of
work would have cost at API prices, and how well token cost explains your quota
consumption.

Everything runs locally. Raw logs never leave your machine, and no prompt,
response, file path, or account identifier ever enters any derived artifact.


> **The name:** TiboTattle is named with affection for the Codex community and
> its patron saint of quota resets. It is not affiliated with or endorsed by
> OpenAI or Thibault Sottiaux, and we will happily rename it if asked. Your
> tokens tattle only to you: everything runs locally and nothing leaves your
> Mac without your explicit, reviewed consent.

## What it shows

- **Allowance tracks** — observed 7-day (and secondary) quota remaining, with
  reset times, reconstructed from local observations.
- **API-price-equivalent usage** — replay-safe totals split into cached input,
  uncached input, reasoning output, and output text, priced from a pinned
  public price registry.
- **Measured versus calculated** — how far observed quota movement diverges
  from cost-implied movement, with a fitted dollars-per-quota-point rate and an
  explicit uncertainty band.
- **Timelines** — hourly/daily/weekly usage against allowance, entirely from
  local evidence.
- **Fast-mode weighting** — Fast turns are counted at the provider's published
  credit rates rather than as if they were Standard. Codex records the speed
  mode only when it is applied or changed, so turns before the first change in
  a session stay an explicit unknown and are excluded from the weighted total
  instead of being quietly counted at 1x.
- **A menu bar item** — where the allowance stands without opening the app,
  including a Check for Updates entry in builds that ship the updater.

## Quick start (macOS, Apple Silicon)

Requirements: macOS on arm64, Node.js ≥ 22.13, [pnpm](https://pnpm.io) 11, and
the Xcode command-line tools for the app build.

```bash
pnpm install
```

Build and open the self-contained desktop app:

```bash
npm run product:macos:build
open ".release-build/macos/TiboTattle.app"
```

Or run just the local dashboard without building the app:

```bash
npm run product:local
```

then open <http://localhost:8787>. A useful headline usually appears within
seconds; the first deep pass over a large history is bounded, cancellable, and
resumable.

## Privacy model

- Local analysis works fully offline; the app installs no daemon, Login Item,
  or background service.
- The dashboard binds to loopback only. The packaged app's network behavior is
  audited at build time (zero JavaScript and zero native network attempts in
  offline mode).
- Contribution to the optional hosted community-aggregate service is **off by
  default**, requires an explicit review of the exact retained metadata, and is
  pseudonymous and content-free. Hosted deletion is always available.
- Contributing requires signing in with Google or Apple so that one person
  counts once. The service stores only an irreversible hash of that sign-in,
  never your name or email, and local-only use needs no account at all.
- Derived artifacts (reports, exports, telemetry) are schema-validated to
  exclude prompts, responses, commands, paths, URLs, and raw identifiers.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/macos`, `apps/local`, `apps/web` | Desktop app shell, loopback companion server, and browser dashboard |
| `apps/worker`, `apps/cloud-run` | Optional hosted contribution service (off by default) |
| `packages/` | Workspace packages: accounting, quota analysis, telemetry contract, identity core |
| `src/` | Product source: `application/`, `platform/`, `export/`, `contribution/`, `reporting/`, `providers/` owners plus compatibility roots |
| `docs/` | Reference, decisions, plans, receipts, and historical goal documents |
| `local-review/` | Reproducible standalone review artifact tooling |

## Development

```bash
npm test
```

```bash
npm run product:check
```

`npm run architecture:check` enforces the ownership boundaries. The complete
command catalog, privacy boundary documentation, and operational detail live in
the [full product reference](docs/reference/product-reference.md).

## Status

This is an early, personal-pilot release (v0.1.0). It is not a
provider-authoritative billing dashboard: quota estimates carry explicit
uncertainty, and unknown models or tiers stay explicit unknowns rather than
silently defaulted. See
[docs/reports](docs/reports/2026-07-29-end-to-end-pilot-readiness-report.md)
for the current verification boundary.

## License

[MIT](LICENSE)
