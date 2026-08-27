---
title: TiboTattle versus CodexBar Lite feature evaluation
date: 2026-08-23
type: review
status: completed
---

# TiboTattle versus CodexBar Lite feature evaluation

## Product decision update — 2026-08-24

The product owner explicitly rejected any TiboTattle UI for reset-credit
availability, detail, expiry, redemption, or purchase. That decision supersedes
the reset-credit recommendation, UI example, acceptance gates, and sequencing
in the original 2026-08-23 evaluation. Reset-credit fields remain intentionally
sanitized and absent from storage, logs, exports, community data, and every
TiboTattle surface. Ordinary five-hour and seven-day allowance reset times are
still in scope because they describe the two observed quota windows, not a
credit inventory.

## Executive decision

CodexBar Lite contains two useful interaction ideas and several choices that
TiboTattle should deliberately avoid. A read-only reset-credit projection was
considered in the original evaluation and is now rejected by explicit product
decision.

Recommended decisions:

1. **Do not expose reset credits.** Do not show availability, count, detail,
   expiry, purchase, or redemption controls. Preserve the existing sanitizer
   boundary even though the official local Codex app-server can supply some of
   those fields.
2. **Build a compact native allowance popover.** Preserve TiboTattle's full
   evidence-oriented app, but make the menu-bar click useful at a glance:
   the fresh five-hour and seven-day allowance windows, used-versus-elapsed
   weekly position, local 7d/30d token history, named coverage, and evidence
   freshness. Reuse the existing fail-closed `MenuBarStatusSnapshot`; never
   keep an old percentage looking current.
3. **Add guided Codex sign-in repair.** When the official app-server reports an
   authentication failure, offer an explicit `Sign in to Codex…` action that
   opens or copies `codex login`, then rechecks readiness. Do not read or decode
   `~/.codex/auth.json` in the app.
4. **Do not fork, depend on, or copy source from CodexBar Lite.** It is an active
   and useful UX reference, but the repository declares no license, has no
   visible product test target or product CI workflow, calls private web
   endpoints with credentials read directly from disk, and ships an ad-hoc
   signed release. Implement selected behavior independently on TiboTattle's
   existing official app-server seam.

This does not change TiboTattle's product wedge. CodexBar Lite is intentionally
a tiny quota checker. TiboTattle should remain a local allowance coach that
explains evidence, provenance, uncertainty, workload composition, and pace—not
compete to become the smallest possible provider cockpit.

## Scope and evidence standard

This evaluation used four evidence levels:

- **A — current source/protocol:** source at pinned commits, existing
  TiboTattle implementation, and the official Codex app-server protocol.
- **B — released artifact:** CodexBar Lite v0.2.5 was downloaded and inspected
  without launching it or supplying account credentials.
- **C — repository metadata:** releases, contributor count, issue/PR history,
  workflows, and visible test/license files as observed on 2026-08-23.
- **D — stated intent:** README and issue comments; useful for direction, but
  not treated as proof of runtime behavior or future delivery.

No reset credit was consumed, no account mutation was performed, and no private
credentials were provided to the competitor app.

## What CodexBar Lite actually is

At the reviewed head, commit
[`85393b0`](https://github.com/wei-b0/codexbar-lite/tree/85393b01106d2b69b2fb1110269e282611bcec89),
CodexBar Lite is a small macOS 13+ Swift/AppKit menu-bar app. Version
[`0.2.5`](https://github.com/wei-b0/codexbar-lite/releases/tag/v0.2.5) was
published on 2026-08-20. Its deliberately narrow product surface is:

- a ring and percentage in the menu bar;
- a compact native popover with the primary window, secondary window, reset
  countdowns/times, plan label, reset-credit count, and last update time;
- notifications at 80%, 90%, exhaustion, and inferred reset;
- 1/5/15/30-minute refresh choices, offline cache fallback, login-item control,
  and Sparkle updates;
- a used-versus-remaining display preference; and
- an explicit sign-in flow that launches `codex login` and watches the local
  auth file for a change.

The product intentionally omits dashboards, graphs, themes, account switching,
and broader analytics. The only open feature request observed was
[#1, Claude Code support](https://github.com/wei-b0/codexbar-lite/issues/1);
the maintainer described that as planned after the UI revamp while wanting to
retain the app's narrow ethos. That is an intent signal, not a shipped feature
or evidence that TiboTattle should enter a provider-count race.

### Implementation and maturity findings

- The app reads `~/.codex/auth.json`, extracts the bearer token and account ID,
  and calls `chatgpt.com/backend-api` directly. It also posts reset redemption
  to a private `wham` endpoint
  ([source](https://github.com/wei-b0/codexbar-lite/blob/85393b01106d2b69b2fb1110269e282611bcec89/Sources/CodexBarLite/main.swift#L86-L90),
  [auth and requests](https://github.com/wei-b0/codexbar-lite/blob/85393b01106d2b69b2fb1110269e282611bcec89/Sources/CodexBarLite/main.swift#L332-L430)).
  TiboTattle should not adopt this credential or endpoint boundary.
- On a refresh failure, the app displays its cached numeric usage and adds a
  warning marker
  ([source](https://github.com/wei-b0/codexbar-lite/blob/85393b01106d2b69b2fb1110269e282611bcec89/Sources/CodexBarLite/main.swift#L250-L283),
  [status item](https://github.com/wei-b0/codexbar-lite/blob/85393b01106d2b69b2fb1110269e282611bcec89/Sources/CodexBarLite/main.swift#L498-L545)).
  This is compact, but weaker than TiboTattle's current rule that stale or
  unavailable evidence collapses to a neutral placeholder.
- The reset control is enabled only when an applicable credit is reported and
  primary usage is exhausted. It uses a three-second, two-click confirmation
  and renders the service outcome before refreshing
  ([popover state](https://github.com/wei-b0/codexbar-lite/blob/85393b01106d2b69b2fb1110269e282611bcec89/Sources/CodexBarLite/UsagePopoverViewController.swift#L358-L427),
  [confirmation/results](https://github.com/wei-b0/codexbar-lite/blob/85393b01106d2b69b2fb1110269e282611bcec89/Sources/CodexBarLite/UsagePopoverViewController.swift#L482-L527)).
  The discoverability is good; the direct-web implementation and confirmation
  semantics are not sufficient for TiboTattle.
- The source tree has one declared runtime dependency, Sparkle. No `Tests`
  product target or product CI workflow was visible; the visible Actions
  workflow deploys GitHub Pages. One contributor accounted for the visible
  commit history. The repository showed 6 stars, 0 forks, and 1 open issue on
  2026-08-23. These are activity snapshots, not adoption or quality proof.
- The repository contains no declared license. Treat the implementation as
  unavailable for reuse unless the maintainer supplies permission or a license.
- The downloaded v0.2.5 ZIP was 2,966,774 bytes with SHA-256
  `2b0478d7e72cdb19fe3e440d49004ff719b89b7b7b7c935cd74ce968f2a17f4e`.
  Its arm64 app bundle passed an on-disk strict code-signature check, but the
  signature was ad hoc and had no Team Identifier. No notarization/Gatekeeper
  acceptance was established. This is adequate for artifact inspection, not a
  mature distribution baseline.

Conclusion: CodexBar Lite is an active early product and a useful source of UX
signals. It is not a safe dependency, fork base, or operational reference for
TiboTattle.

## Feature decision matrix

| Capability | CodexBar Lite | Current TiboTattle | Decision |
| --- | --- | --- | --- |
| Primary/secondary usage and reset times | Compact popover | Already supported with stronger freshness/evidence semantics | **Keep current** |
| Reset-credit count and details | Shows count/applicability | Official response is read, then intentionally removed by the sanitizer | **Do not expose; preserve sanitization** |
| Reset-credit redemption or purchase | Direct private HTTP POST with two-click confirmation | Not supported; current design excludes account actions | **Explicitly do not support** |
| Visual menu-bar popover | Polished 320-point glance view | Native menu rows plus full app | **Prototype without replacing full app** |
| Authentication repair | Launches `codex login`; watches `auth.json` | Authentication failure is surfaced but no guided recovery action was found | **Build via app-server/CLI boundary** |
| Used/remaining preference | User-selectable everywhere | Remaining allowance is the product's primary language | **Low priority; show both in detail instead** |
| Threshold/reset notifications | 80/90/100 and inferred reset | Already richer, fresh-only, disclosure-led, and off by default | **No feature gap** |
| Refresh intervals | 1/5/15/30 minutes | Same foreground choices already exist | **No feature gap** |
| Cached offline number | Keeps showing old number with warning | Fails closed in the status item | **Reject competitor behavior** |
| Launch at login and updates | Supported | Already supported | **No feature gap** |
| Raw plan/account display | Plan pill and account-ID-derived settings UI | Plan variants/account identity are deliberately bounded | **Do not copy** |
| Claude/provider expansion | Requested, not shipped | Deliberately Codex-specialist | **Do not reprioritize** |

## Rejected opportunity: reset-credit awareness

The original evaluation identified a technically available read-only field,
but that is not sufficient reason to make it part of TiboTattle. The explicit
2026-08-24 product decision is to omit reset-credit availability, count,
details, expiry, purchase, and redemption from all product surfaces. This is a
scope and privacy boundary, not an implementation deferral or backlog item.

For historical evidence, the official Codex app-server's read-only
`account/rateLimits/read` response includes
`rateLimitResetCredits.availableCount` and optional, potentially capped
details. The separate protocol also defines a consume method. Neither capability
should be projected or invoked by TiboTattle.

See the pinned official
[app-server protocol documentation](https://github.com/openai/codex/blob/479c8c8924eaafdeb56e86154cd19ff0805839e4/codex-rs/app-server/README.md#L2420-L2466)
and
[v2 account types](https://github.com/openai/codex/blob/479c8c8924eaafdeb56e86154cd19ff0805839e4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L303-L395).

TiboTattle already performs `account/rateLimits/read` through its bounded
client in [`src/providers/codex/app-server.js`](../../src/providers/codex/app-server.js).
The omission is intentional: the account snapshot sanitizer removes the
reset-credit object, and
[`test/normalization.test.js`](../../test/normalization.test.js)
asserts that counts and identifiers cannot survive serialization. That privacy
test should remain true for all observations and UI inputs.

The enforceable product contract is:

- preserve reset-credit removal at the sanitizer boundary;
- add no owner-only or ephemeral reset-credit projection;
- expose no availability, balance, detail, expiry, Use, Redeem, Reset, or Buy
  control;
- add no `account/rateLimitResetCredit/consume` client method, credit ID
  retention, or redemption idempotency key;
- make no background, automatic, or user-triggered credit requests; and
- keep reset-credit fields out of logs, diagnostics, persistence, exports,
  hosted contribution, and community aggregates.

This preserves the existing non-goal in
[`docs/goals/2026-07-24-multi-surface-account-provider-goal.md`](../goals/2026-07-24-multi-surface-account-provider-goal.md).

## Selected opportunity: compact native allowance popover

CodexBar Lite's strongest generalizable design choice is not a new metric; it
is reducing the distance between a menu-bar click and the answer. TiboTattle's
native status item already has the right safety model and actions, but its menu
rows are less glanceable than a visual popover.

Prototype left-click behavior with:

- exactly the fresh five-hour and seven-day remaining-allowance tracks, with
  each window's own reset countdown/time;
- a same-scale weekly used-versus-elapsed comparison with a clear above/on/below
  even-pace label that is explicitly not a forecast;
- a 7d/30d local civil-day token chart that names partial or missing coverage;
- evidence state and observation time;
- one phase-aware next action, such as Update, Finish setup, Sign in, or Open
  details; and
- a link to the full TiboTattle window for provenance, pace, composition, and
  diagnostics.

An illustrative live state—not final visual styling—would be:

```text
┌──────────────────────────────────┐
│ TiboTattle                    ••• │
│                                  │
│  5 hours              37% remains│
│  ███████░░░░░░░░░░░░░░░░░░░░░░ │
│  Resets in 2h 14m               │
│                                  │
│  7 days               62% remains│
│  ████████████░░░░░░░░░░░░░░░░░ │
│  Resets Tuesday, 11:00 AM        │
│                                  │
│  Weekly position     Above pace  │
│  Elapsed  ███████████░░░░░░░░░░ │
│  Used     ███████████████░░░░░░ │
│  Used vs elapsed · not a forecast│
│                                  │
│  Tokens                    7d 30d │
│  ▂ ▃ ▅ ▂ ▆ ▇ ▄   Partial today  │
│                                  │
│  [ Open TiboTattle ]    [ Update ]│
└──────────────────────────────────┘
```

There is deliberately no credit row and no redemption or purchase button. A
stale/error state replaces the percentages and derived weekly position with a
neutral “Allowance unavailable” explanation and an Update action; it does not
keep showing the last numeric values as if they were current. Missing history
coverage is named rather than rendered as zero, and partial pricing can support
only a labelled known subtotal rather than a complete cost claim.

Keep right-click or an ellipsis menu for Refresh, Settings, Updates, About, and
Quit. Reuse `MenuBarStatusSnapshot` and the companion's existing freshness
vocabulary rather than creating a second quota calculation path.

Do not copy these details from CodexBar Lite:

- showing an arbitrarily old cached number in the status item;
- a generic `PRO` pill, because TiboTattle must distinguish unresolved 5x/10x/
  20x plan variants rather than imply certainty;
- exposing the raw account ID, even in a tooltip;
- treating the popover as a replacement for the evidence-oriented app; or
- default-on attention features that bypass first-run disclosure.

The used/remaining switch is not worth a new top-level preference. Keep
“remaining” as the menu-bar language and, where space allows, show both facts
in detail—for example, `37% remaining · 63% used`.

## Selected opportunity: guided authentication repair

CodexBar Lite turns a missing auth file into a direct sign-in action. The useful
idea is the guided recovery, not reading the auth file.

TiboTattle should respond to a known app-server authentication-required state
with an explicit `Sign in to Codex…` action. The action can open a Terminal
command or copy `codex login`, explain that Codex owns the authentication flow,
and poll/retry the official app-server readiness check for a bounded period.
It should not launch Terminal automatically on ordinary app startup, inspect
token contents, display a raw account ID, or infer success from an auth-file
timestamp. On success, run the normal refresh path so account continuity,
freshness, and sanitization rules remain centralized.

## Already covered; no new work justified

CodexBar Lite does not reveal a meaningful gap in these areas:

- primary and secondary quota windows and reset times;
- 1/5/15/30-minute foreground refresh choices;
- launch-at-login control and app updating;
- warning notifications at high usage and reset notifications; or
- local cached analysis and manual refresh.

TiboTattle's notification design is stronger because it is disclosure-led,
off by default, fresh-evidence-only, and has bounded deduplication and
schedule-aware reset handling. CodexBar Lite's simpler reset inference—reset
time changed and usage declined—is not a reason to simplify it.

There is one documentation follow-up: the root README still says reset alerts
are unavailable without reset identity, while current macOS source supports a
schedule-only fallback with safeguards. That is documentation drift, not a
feature gap from this comparison.

## Explicit skip list

Do not pursue the following because of this comparison:

- **Reset-credit surfaces or actions.** Keep availability, detail, expiry,
  purchase, and redemption outside TiboTattle; preserve sanitizer redaction.
- **Claude or provider breadth.** One competitor issue is not demand evidence,
  and breadth conflicts with TiboTattle's specialist allowance-coach wedge.
- **Menu-only product simplification.** It would remove the provenance,
  uncertainty, composition, calibration, and research value that differentiates
  TiboTattle.
- **Direct `auth.json` access or private backend calls.** The official local
  app-server is already the safer and more maintainable integration seam.
- **Raw account/plan display.** It conflicts with current identity and plan
  uncertainty boundaries.
- **Indefinite stale-number display.** A warning glyph does not make stale quota
  evidence current.
- **Default-on notifications or login-item behavior.** Preserve explicit
  disclosure and user choice.
- **Copying the competitor's code or release tooling.** The missing license,
  absent product tests/CI, direct endpoint coupling, and ad-hoc distribution
  provide no advantage over an independent, native implementation.

## Sequencing recommendation

This comparison should not displace the existing Evidence Coach and Workload
Composition beta. The most coherent sequence is:

1. Build the compact popover on top of the existing fail-closed status and
   overview models, limited to fresh five-hour/seven-day allowance, weekly pace,
   and coverage-aware 7d/30d local history.
2. Verify that reset-credit availability, detail, expiry, purchase, and
   redemption remain absent from source, localized copy, fixtures, screenshots,
   persistence, logs, exports, and community data.
3. Add guided sign-in repair as another phase-aware action.
4. Dogfood the read-only allowance, history, and authentication-repair paths.

This sequence captures CodexBar Lite's useful interaction ideas while
strengthening, rather than diluting, TiboTattle's privacy and evidence model.

## Validation receipt and limitations

- TiboTattle source was inspected at detached HEAD
  `4cb5c48955c2a49861927ef51d6738eab0ef7763`; the worktree was clean before
  this report was added.
- CodexBar Lite source was inspected at
  `85393b01106d2b69b2fb1110269e282611bcec89`; release v0.2.5 was inspected
  without execution or credentials.
- Official Codex protocol/source was inspected at
  `479c8c8924eaafdeb56e86154cd19ff0805839e4`.
- Focused TiboTattle tests were attempted, but this isolated worktree lacks
  installed workspace dependencies: the macOS bundle test stopped at missing
  `es-module-lexer`, and the normalization test stopped at missing
  `@app-usagemonitor/telemetry-contract`. No product test failure was observed,
  but no fresh passing test receipt is claimed.
- No live-account reset-credit response was captured or required. Credit
  availability/details and every purchase or redemption path are explicitly
  outside scope; the redaction boundary remains the relevant validation target.

## Primary evidence links

- [CodexBar Lite repository at reviewed commit](https://github.com/wei-b0/codexbar-lite/tree/85393b01106d2b69b2fb1110269e282611bcec89)
- [CodexBar Lite v0.2.5 release](https://github.com/wei-b0/codexbar-lite/releases/tag/v0.2.5)
- [CodexBar Lite UI revamp PR #2](https://github.com/wei-b0/codexbar-lite/pull/2)
- [Codex reset-credit app-server documentation](https://github.com/openai/codex/blob/479c8c8924eaafdeb56e86154cd19ff0805839e4/codex-rs/app-server/README.md#L2420-L2466)
- [TiboTattle Codex app-server client](../../src/providers/codex/app-server.js)
- [TiboTattle reset-credit redaction test](../../test/normalization.test.js)
- [TiboTattle account-provider privacy/non-goals](../goals/2026-07-24-multi-surface-account-provider-goal.md)
- [Prior TiboTattle versus CodexBar strategic audit](2026-08-08-tibotattle-vs-codexbar-comprehensive-feature-audit.md)
