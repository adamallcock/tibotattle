---
title: Codex plan and seat contract synchronization
date: 2026-08-26
type: decision-record
status: implemented
---

# Codex plan and seat contract synchronization

## Decision

Treat the Codex `planType` wire value as the observed subscription or workspace-plan evidence. Keep its bounded raw identifier in telemetry and map it through one exhaustive, audited display-name registry. Do not infer a plan or seat from quota-window durations, prices, multipliers, or marketing announcements.

`unknown` remains unavailable evidence and has no public display name. A new
raw value must remain unavailable until the registry, schemas, tests, and
human-readable name are deliberately updated together. There is no title-case
fallback for an internal token.

## Sources of truth

As of 2026-08-26, the installed ChatGPT Codex binary is
`codex-cli 0.150.0-alpha.8`. Its generated app-server `PlanType` contract
contains:

```text
free, go, plus, pro, prolite, team,
self_serve_business_prolite, self_serve_business_usage_based,
business, ent26, enterprise_cbp_automation,
enterprise_cbp_usage_based, enterprise, edu, edu_plus, edu_pro,
unknown
```

OpenAI documents generated app-server TypeScript and JSON Schema as the exact
contract for the CLI version that generated it. The public Codex CLI source is
authoritative for the paired raw identifiers and human-readable names:

- [Codex app-server schema generation](https://learn.chatgpt.com/docs/app-server)
- [`KnownPlan::raw_value()` and `KnownPlan::display_name()` at the reviewed revision](https://github.com/openai/codex/blob/b68acc4d4b56fdfa1d5b6a2c36102c66876e0c46/codex-rs/protocol/src/auth.rs)
- [app-facing `PlanType` and workspace-family helpers](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/account.rs)
- [`account/read` app-server contract](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs)

| Raw `planType` | Codex display name |
| --- | --- |
| `free` | Free |
| `go` | Go |
| `plus` | Plus |
| `pro` | Pro |
| `prolite` | Pro Lite |
| `team` | Team |
| `self_serve_business_prolite` | Self Serve Business ProLite |
| `self_serve_business_usage_based` | Self Serve Business Usage Based |
| `business` | Business |
| `ent26` | Enterprise |
| `enterprise_cbp_automation` | Enterprise (Automation) |
| `enterprise_cbp_usage_based` | Enterprise CBP Usage Based |
| `enterprise` | Enterprise |
| `edu` | Edu |
| `edu_plus` | Edu Plus |
| `edu_pro` | Edu Pro |

## Seats versus plans

The app-server surfaces inspected here expose `planType`; they do not expose a separate `seatType`. [OpenAI's Business-seat announcement](https://openai.com/index/premium-seats-chatgpt-business/) names the two marketed seats **Standard** and **Premium**. Premium has 5× the usage of Standard, no five-hour limit, and a predictable weekly reset. The CLI contract does not make those marketing labels a second dimension.

`self_serve_business_prolite` is the strongest candidate for the new Business
Premium seat because it is a self-serve Business workspace variant carrying
the Pro Lite identity. That association is an inference, not a verified wire
mapping. The contract ledger records the official seat-name evidence and an
empty mapping-evidence list so this cannot silently become product truth.
Confirm it from an actual Premium account's provider-reported `planType` or an
official wire-contract source before changing the public label to “Business
Premium.”

## Continuous synchronization

The repository keeps a normalized, reviewed contract in
`config/codex-contract-ledger.json`. It records:

- the exact `openai/codex` source revision and source digest;
- every raw plan identifier, official Codex display name, and lifecycle;
- verified released-binary `PlanType` digests by version and channel; and
- official marketing seat names independently from candidate or verified wire
  mappings.

`.github/workflows/codex-contract-drift.yml` runs an offline parity check on
relevant pull requests. On `main`, manual dispatch, and a daily schedule it
also resolves the exact current `openai/codex` commit and the latest published
`@openai/codex` version, then checks both without lifecycle scripts. The
workflow is read-only and never rewrites the ledger or opens a pull request.
Its path-free JSON reports are retained for diagnosis.

Run the same checks locally:

```sh
npm run codex:contract:check
npm run codex:contract:release:check
```

The release check discovers supported local channels, generates `PlanType.ts`
with that exact binary, and fails if no binary is available, a new identifier
is unsupported, `unknown` disappears, or a previously recorded version changes
contract. Stable schema generation is attempted first, with the older
`--experimental` form only as a compatibility fallback.

## Reviewing a future change

1. Inspect the failed report and pin the exact source revision and released
   binary version. Do not infer a name from duration, price, multiplier, or
   marketing copy.
2. Read `KnownPlan::display_name()` for each new identifier. If source and
   released schema disagree, retain `unknown` behavior and wait for a coherent
   published contract.
3. Update the ledger, telemetry allowlist/display registry, TypeScript
   declarations, JSON Schemas, and focused normalization/UI tests together.
4. Regenerate telemetry and upload-schema mirrors, then run parity and release
   checks.
5. Only after the semantic review is clean, record the exact installed binary
   evidence explicitly:

   ```sh
   npm run codex:contract:record-installed
   ```

`--update-ledger` advances provenance only after a clean comparison; it never
imports an unknown name or changes product allowlists. If an upstream value is
retired, mark it `deprecated` rather than deleting telemetry acceptance, so
historical local observations remain readable.

The exhaustive key-set tests make a local plan-vocabulary change fail until it
also receives a deliberate human-readable name. App-server does not return
plan display names at runtime, so source and generated schema remain explicit
review inputs rather than runtime network dependencies.

## Adjacent rollout compatibility

The contract monitor is deliberately focused on plan and display-name drift;
it is not a substitute for behavioral qualification against real rollout
history. The same review found two newer, valid Codex JSONL forms:

- the first `SessionMeta` in a rollout is canonical, while later metadata may
  be copied fork history or an appended metadata update; and
- `RateLimitSnapshot` can carry credits or spend-control state with both
  rolling windows absent.

The provider scanner, checkpoint scanner, and durable local index accept those
forms while still rejecting a malformed canonical head or malformed window
object. Provider `limit_name` is sanitized into local display metadata when a
window is present. Focused parity tests cover the forms, and the R7 real-history
gate qualifies the combined behavior against the frozen local corpus under
both release runtimes.

Primary-source references:

- [Codex's first-`SessionMeta` canonical rule](https://github.com/openai/codex/blob/7c3747941a6b664c30f1e6aa72a917fd74dc22d2/codex-rs/rollout/src/recorder.rs)
- [Codex `RateLimitSnapshot` optional windows](https://github.com/openai/codex/blob/7c3747941a6b664c30f1e6aa72a917fd74dc22d2/codex-rs/protocol/src/protocol.rs)

This layered approach is intentional: scheduled schema/source drift catches
published vocabulary changes early, focused fixtures lock reviewed semantics,
and release-time installed-binary plus real-history checks catch behavioral
changes that a source parser cannot infer safely.
