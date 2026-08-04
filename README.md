# TiboTattle

Privacy-first, local-only monitoring for coding-agent usage. TiboTattle
reads the session metadata that Codex already stores on your Mac, reconstructs
your usage at standard API prices, and compares it with the quota movement your
provider reports — so you can see where your allowance stands, what a week of
work would have cost at API prices, and how well token cost explains your quota
consumption.

Everything runs locally. Raw logs never leave your machine, and no prompt,
response, file path, or raw account identifier ever enters any derived
artifact.


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

For development only, run the local dashboard in an external browser without
building the app:

```bash
npm run product:local
```

then open <http://localhost:8787>. A useful headline usually appears within
seconds; the first deep pass over a large history is bounded, cancellable, and
resumable.

## Languages

TiboTattle ships English, Simplified Chinese, and Spanish for its native shell,
local dashboard, and public community/install surface. New users follow a safe
system-language match with English fallback; General settings and the web
header both provide a persisted override. Language choice does not change
regional number/date formatting, event times, or quota/pricing semantics. See
[the localization decision record](docs/decisions/2026-08-03-localization-system.md)
for the provenance and future-locale policy.

## Privacy model

- Local analysis works fully offline. On a new macOS install, the first-run
  disclosure visibly preselects **Start TiboTattle at login**, but TiboTattle
  registers the native Login Item only after the person confirms **Get
  Started**. Settings re-reads the real macOS state after a request or return
  from System Settings, and can remove an approval-pending request as well as
  an enabled item. This starts the normal app at login; it does not install a
  daemon, LaunchAgent, privileged helper, or separate background worker.
- Optional macOS allowance notifications are **off by default** and local-only.
  If enabled in **Settings → General**, they are evaluated only after the
  existing foreground refresh receives fresh direct provider quota evidence.
  Stale, inferred, mixed-source, unknown, unobserved, forecast, and
  log-derived state never notifies; turning the same switch off immediately
  stops future alerts and clears only their local pending/dedupe state.
  The current provider receipt supplies a reset schedule but no reset identity,
  so reset alerts are visibly unavailable rather than inferred from time or a
  percentage change.
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

For native iteration, start with a deterministic preflight and the source-only
macOS lane:

```bash
npm run test:fast
npm run test:macos:smoke
```

`test:macos:smoke` builds one development-only app with the test compiler
profile; that profile cannot create preview or external-distribution output.
Use `npm run test:changed -- --base <revision>` to select known changed paths,
which includes `<revision>...HEAD` plus staged, unstaged, and untracked local
paths. It narrows only reviewed native app/build and i18n paths: native source
changes include the test-profile smoke, and `--full` adds the expensive
bundle-artifact lane. Web, local-server, shared configuration, runner, and
unfamiliar paths conservatively run the complete `npm run check` gate. The
smoke lane requires macOS arm64 with the pinned Node v26.2.0 builder; it fails
rather than falsely reporting a smoke result on another platform. The retained
release-quality macOS gate is always:

```bash
npm run product:macos:test
```

`npm test` and lane execution remain serial by design. The artifact lane itself
uses two isolated OS-level builder processes for its reproducibility check;
each build has a separate output and compiler scratch directory. Measure the
local lanes with `npm run test:benchmark` (or `test:benchmark:release` to
include the retained release gate).

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
