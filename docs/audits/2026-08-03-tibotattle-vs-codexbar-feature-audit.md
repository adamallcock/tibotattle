---
title: TiboTattle versus CodexBar feature audit
date: 2026-08-03
type: review
status: completed
---

# TiboTattle versus CodexBar feature audit

## Executive conclusion

**Do not fork or try to clone CodexBar.** Use CodexBar today when the job is a
broad, immediately legible menu-bar view of many AI-provider limits, alerts,
and spend. Build TiboTattle only as the narrower product it can credibly own:
an evidence-grade, local-first Codex allowance and API-price-equivalent
accounting companion.

That is a real product boundary, not a consolation prize. CodexBar is already
the much stronger *provider-control surface*; TiboTattle is materially stronger
where a user needs to know what was observed, what was inferred, which account
and reset window are comparable, which data are unknown, and what may leave the
Mac. Trying to reproduce dozens of provider adapters, browser-cookie handling,
credential storage, iCloud sync, widgets, and a background menu-bar agent would
erase the latter advantage while starting a permanent compatibility burden.

The recommended posture is therefore:

- **Use** CodexBar for multi-provider, real-time menu-bar status now.
- **Build** TiboTattle's Codex-specific evidence, explainability, and optional
  consented community layer.
- **Wrap only if proven useful:** a deliberately sanitized, read-only status
  bridge is plausible, but only after exact identity, schema, provenance, and
  no-credential/no-raw-log tests.
- **Contribute** small generic privacy, provenance, or provider-schema fixes
  upstream when an actual shared gap appears.
- **Do not fork.** Both projects are MIT, but CodexBar is a large, fast-moving
  multi-provider Swift product whose auth and provider maintenance model is the
  opposite of TiboTattle's intended boundary.

## Scope and evidence standard

This is a feature and product-boundary audit, not a claim that either product
has been exercised against every provider account.

| Label | Meaning |
| --- | --- |
| **Release** | Publicly downloadable/released behaviour or official release notes. |
| **Source** | Visible in the pinned source tree, but not necessarily run against a live account. |
| **Contract** | Covered by a focused test or packaged smoke. It proves the stated contract, not all user journeys. |
| **Preview** | Seen in the installed TiboTattle preview build; this is not a production-release claim. |

### Snapshot

- **CodexBar:** public `main` was pinned by `git ls-remote` to
  [`94efcfdf`](https://github.com/steipete/CodexBar/tree/94efcfdf4a4be495ddc80ad5193d4e488df06450).
  Its latest public release when checked was
  [v0.47.0](https://github.com/steipete/CodexBar/releases/tag/v0.47.0), tag
  `6a16c23313a782dee6861735116a6c06ec1338fe`, released on 2026-08-03. `main`
  is 17 commits beyond that tag and begins an unreleased 0.47.1 changelog, so
  main-only plugin work is marked **Source**, not **Release**.
- **TiboTattle:** local branch `codex/integrate-spark-exclusion` at
  `340d602672f039c9651be6df5777bb027d042d68`, with substantial pre-existing
  modified and untracked work. That makes source-visible features useful audit
  evidence, but not a release claim. The installed app reports `0.1.0` and
  `preview_distribution`. A current-reset pace feature was added to the dirty
  tree while this audit was underway; its final source/test state is reported
  below as **Source/Contract**, never as a shipped feature.
- No account credentials, browser cookies, raw logs, provider requests,
  identity sign-in, uploads, or hosted deletion were exercised in this audit.

## Central feature matrix

| Feature area | CodexBar | TiboTattle | Audit result |
| --- | --- | --- | --- |
| **Primary job** | **Release/Source:** a compact menu-bar dashboard for limits, resets, credits, cost, and status across many coding-AI providers. | **Source:** a foreground, local-first Codex monitor that reconstructs usage, estimates API-price-equivalent cost, and compares observed allowance movement with that estimate. | Different products. CodexBar wins at glanceability and breadth; TiboTattle has the stronger measurement thesis. |
| **Mac interaction model** | **Release:** macOS 14+ menu-bar-only app (`LSUIElement`), no Dock icon; supports one status item per provider or merged icons. | **Source/Contract:** regular foreground Mac app with Dock window plus an additive status item and local loopback dashboard; no daemon/login item. | Preserve TiboTattle's foreground model. It is safer for explicit analysis and evidence review; do not copy a menu-only agent merely for parity. |
| **Provider coverage** | **Release/Source:** 67 registered provider IDs, including Codex, Claude, Cursor, Gemini, Copilot, OpenRouter, Bedrock, and many API/cookie-backed services. The providers doc table has 63 rows, so it is not the exhaustive count. | **Source:** the consumer allowance path is Codex-specific. A privacy-minimized Claude statusline/transcript adapter exists, but a supported Claude consumer dashboard is not verified. | **Major CodexBar lead.** Do not answer it with a generic provider catalogue. |
| **Provider acquisition** | **Source:** source strategies include existing OAuth/device sessions, API keys, provider CLIs, local configuration/logs, browser sessions/cookies, and manual credentials depending on provider. | **Source:** reads the installed Codex app-server and bounded known Codex session metadata; it does not make the product a credential collector. Google/Apple are only for an optional contribution identity flow. | TiboTattle's narrower acquisition surface is a strategic privacy advantage, not a missing checkbox. |
| **Accounts and multi-account UX** | **Release/Source:** multi-account/provider switching, provider toggles, account grouping, and fresh/stale last-known data handling. | **Source:** account-scoped Codex observations use a keyed, privacy-preserving scope to prevent mixed-account analysis; no broad multi-account switcher is verified. | CodexBar wins for account management. TiboTattle wins at refusing to mix data. Keep that distinction. |
| **Current quota/reset state** | **Release:** session, weekly, monthly, and provider-specific windows with reset countdowns and meters. | **Source:** normal Codex five-hour and weekly allowance windows, reset state, freshness and failure state; non-primary Spark limits are explicitly separated. | Functional parity for the focused Codex question; CodexBar has much wider window/provider coverage. |
| **Historical usage and cost** | **Release/Source:** provider-specific cost/usage scans, local 7/30-day estimates, API/admin cost views, charts where data permits. | **Source:** replay-safe cumulative accounting split by cached/uncached input, reasoning output, and output text; event-time pinned pricing and explicit unknown/unpriced coverage. | **TiboTattle lead for auditability and pricing provenance; CodexBar lead for breadth and immediate provider coverage.** |
| **Allowance-versus-cost calibration** | **Source:** pace, ETA, run-out estimates and Codex historical usage curves. | **Source:** observed-versus-cost-implied movement, residuals, MAE/uncertainty, policy epochs, reset evidence, and refusal codes. | TiboTattle has the better scientific substrate. It must not present a polished numerical risk before calibration has earned it. |
| **Run-out forecast** | **Source/Release:** reset-aware pace and historical run-out presentation. The upstream implementation is useful, but this audit found no visible held-out probability-calibration result. | **Source/Contract, uncommitted:** a current-reset-only deterministic median-pace/ETA engine and optional dashboard card now hide until usable, reject stale/incompatible/backward/implausible data, and intentionally make no probability or token claim. Focused source tests pass 12/12. | This is a good bounded first step. It is not a shipped/calibrated forecast yet, and it should not borrow CodexBar's wording or browser-history assumptions. |
| **Dashboard depth** | **Release:** compact menu cards, provider charts, cost/usage views, and a Settings-led configuration experience. | **Source:** native shell plus detailed local dashboard: allowance, timelines, accounting method, coverage/blind spots, calibration/residual views, contribution review, and community status. | CodexBar wins at glanceable operational UI; TiboTattle wins at explanation and provenance. |
| **Menu-bar integrity** | **Release:** mature menu-only interaction, merged layouts, provider switching, display choices, stale/error dimming. | **Contract:** current source uses native titled `NSMenuItem` rows and neutral stale/unavailable states, with Escape, same-app click-away, and deactivation dismissal. The packaged menu contract smoke passes. | The historical blank custom-view regression is **not evidenced in current source/contract**. The installed preview still needs a fresh visual check; CodexBar leads in compactness, widgets, and sophisticated multi-provider layout. |
| **Refresh and power policy** | **Release/Source:** manual/fixed 1–30 minute/adaptive refresh, optional agent-aware process inspection, and a low-power setting in v0.47.0. | **Source:** explicit local analysis, launch/five-minute in-app refresh, bounded foreground processing, no background service. | CodexBar leads in adaptive operation. TiboTattle should retain its no-daemon rule and only add controls that do not imply data freshness it cannot prove. |
| **Agent/session awareness** | **Source:** opt-in, bounded local Codex/Claude/pi/OMP session and process activity; optional SSH/Tailscale session signals; no transcript-body analytics. | **Source:** classified local Codex lineage/surfaces and `mark-activity`, but no comparable proactive process scanner, remote-session layer, or user-facing session agent control. | CodexBar leads. Treat this as a separate product direction, not a prerequisite for trustworthy local accounting. |
| **Notifications and automation** | **Release:** quota/reset notifications, incident badges, reset confetti, and `codexbar hooks watch` for edge-triggered quota/status events with JSON output. | **Source review:** no user-facing native/email/push/webhook alert path was found. | **Real gap only if users need it.** Add opt-in local threshold/reset notifications after freshness gates; do not alert on inferred/stale/unknown state. |
| **Provider incident status** | **Release/Source:** provider status polling and incident overlays in menu icons. | **Source review:** no comparable provider-status service was found. | Defer unless it explains a real local “unavailable” state; generic status badges would not strengthen TiboTattle's core value. |
| **CLI, scripting, and headless use** | **Release:** bundled macOS/Linux CLI, config commands, cost/status/serve/guard workflows, and hook/watch use cases. | **Source:** research/operational CLI and a loopback companion exist, but no general customer-facing status CLI or provider-plugin interface is verified. | CodexBar leads. A small, provenance-bearing read-only Tibo status JSON/CLI is a better future experiment than duplicating CodexBar's key-management CLI. |
| **Widgets and non-macOS use** | **Release:** WidgetKit widgets and macOS/Linux CLI distribution; an ecosystem of panel integrations is documented. | **Source:** Apple-silicon macOS personal pilot. | Clear CodexBar lead. Defer cross-platform and widgets until the focused product earns demand. |
| **Synchronization/community** | **Release:** v0.47.0 adds opt-in iCloud sync of selected preferences, provider configuration, and per-device snapshots; secret-bearing fields have their own opt-out. | **Source:** optional, reviewed, content-free community contribution with queue/review/deletion lifecycle; raw logs remain local and local use requires no account. The Worker/R2 service is not a publicly proven deployment. | Different bets. TiboTattle's aggregate/community thesis is distinctive; do not add personal iCloud sync by default. |
| **Identity and authentication** | **Release/Source:** broad provider OAuth/device/API/cookie/key flows, each with inherent refresh and support costs. | **Source:** accountless local use; Google/Apple sign-in only when a user chooses optional contribution, with a pseudonymous/content-free service boundary. | TiboTattle's smaller identity surface is a trust advantage. Its public contribution path still needs live release proof. |
| **Privacy and secrets** | **Release/Source:** local parsing by default, opt-in browser/session use, restrictive config permissions, and documented Keychain/cookie controls. It can necessarily retain provider credentials when users configure such sources. | **Source:** local-only default, content-exclusion schemas, owner-only state, zero-egress/offline audit route, explicit review before optional contribution, and no raw prompt/response/path/account identifier in derived artifacts. | **TiboTattle lead for strict minimization and explainable consent.** Avoid importing browser-cookie or broad API-key collection just to match a feature list. |
| **Exports and evidence** | **Source:** CLI/config output and operational diagnostics, with cost-focused workflows. | **Source:** schema-validated local review/export artifacts, receipts, privacy scans, replay-safe checkpoints, and deletion/recovery contracts. | TiboTattle lead in inspection/reproducibility; this is valuable to advanced users and for its community claim. |
| **Configuration and customization** | **Release:** provider enablement, display layout, icon/label/bar/reset choices, refresh modes, account UI, and broad settings. | **Source:** Codex-home choice, update preference where available, Fast-mode/accounting settings, contribution controls, and an English localization foundation. | CodexBar leads on choice; TiboTattle should add only settings that own an observed behavior. More settings are not automatically product progress. |
| **Localization** | **Release:** shared 21-language catalogue, automatic web detection, pickers, and RTL support. | **Source:** `en-US` only; localization plumbing exists but no additional shipped catalogue/picker is verified. | Genuine future accessibility/international gap, but not a v0.1 priority without a user base. |
| **Extensibility** | **Source:** provider descriptor/strategy architecture and authoring guide. `main` also has a tested JavaScript provider-plugin runtime with bounded execution, validation, and cookie/host capabilities; that 0.47.1 work is unreleased. | **Source:** modular internal domains but hard-coded provider integration; no generic public plugin API verified. | CodexBar leads. TiboTattle should not build a generic extension system before it has a second provider that survives the same evidence standard. |
| **Release/distribution maturity** | **Release:** v0.47.0 universal macOS release, Homebrew, Linux CLI tarballs, Sparkle/appcast, and a documented signed/notarized release flow. | **Source/Preview:** fail-closed Sparkle/release scripts and update contracts exist; inspected local bundles are arm64/ad-hoc and the installed app is a preview. The source runbook still gates a public installer on Developer ID/notarization/stapling/Gatekeeper/clean-profile checks; a public appcast and connected Worker/R2 path are not proven. | **Highest non-feature gap.** TiboTattle needs a real release proof before feature expansion. |

## What TiboTattle should protect

The following are not merely implementation details. They are the product
reasons not to turn TiboTattle into CodexBar-with-fewer-providers:

1. **Evidence over an appealing number.** Preserve current-source distinctions
   among provider-reported state, local observation, inference, partial
   coverage, and unknowns. A quota estimate should never look provider
   authoritative when it is not.
2. **Account and reset-window integrity.** Continue to refuse mixed account,
   plan, policy-epoch, duration, stale, backward, or ambiguous data rather
   than filling gaps with a plausible default.
3. **Event-time price provenance.** Keep historical pricing separate from a
   current-price comparison. The accounting story is more credible when a
   person can see what price basis generated a result.
4. **Explicit, local-first consent.** Keep raw agent material on the Mac;
   require a reviewed, schema-checked, content-free export before anything is
   contributed. Do not turn browser session access into a default.
5. **A foreground, recoverable workflow.** The Mac app's current explicit
   Analyze/retry lifecycle is appropriate for a bounded local scan. It should
   remain legible rather than pretending continuous background monitoring.

## Recommended action plan

Priorities use a rough relative RICE lens (reach × impact × confidence ÷
effort), not false-precision estimates.

| Priority | Recommendation | Why it ranks here | Gate / counterargument |
| --- | --- | --- | --- |
| **P0** | Finish a production trust path: Developer ID signing, notarization/stapling, live signed appcast, clean-profile install, update, rollback, and first-run evidence. | It turns the existing source/preview work into a product someone can safely adopt. | Do not declare this complete from an ad-hoc bundle or a source test. The counterargument is opportunity cost, but a richer feature set cannot compensate for an unproven installer. |
| **P1** | Ship and visually verify one concise Codex “now” surface: primary allowance lane(s), reset, last observed, freshness, and one manual refresh. | It borrows CodexBar's best interaction lesson without absorbing its scope. Much of the source contract already exists. | Test starting, live, stale, unavailable, and post-restart states in an installed signed app. Do not add dense menu cards before those five states are stable. |
| **P1** | Add local-only, opt-in threshold/reset notifications only for fresh, provider-reported evidence. | It fills a practical CodexBar advantage while reinforcing TiboTattle's truthfulness. | Suppress notifications for stale, inferred, mixed, or unobserved state. If users do not act on these prompts, remove rather than escalating alert volume. |
| **P1 research gate** | Finish/release the new bounded current-reset pace card, then add a historical Codex allowance forecast only when it is account-scoped, reset-comparable, and backtested. | CodexBar demonstrates that people value this answer; TiboTattle can make it more defensible. | The present pace card must stay deterministic and explicitly non-probabilistic. No numeric probability until several comparable historical windows and held-out replay report interval coverage/calibration. Do not infer a subscription allowance directly from API-priced dollars. |
| **P2** | Trial a tiny read-only compatibility surface (JSON/CLI or a local adapter) only if users demonstrably need a combined view. | It could let a power user retain CodexBar's multi-provider bar while seeing TiboTattle's qualified Codex evidence. | Require exact account identity, metric schema, freshness, and no-secrets/no-raw-logs tests first. Do not couple TiboTattle to an unstable internal provider contract prematurely. |
| **P3** | Finish a supported Claude path only after demand and a low-risk official/local source are proven. | The local building blocks are present, but CodexBar already covers Claude and ongoing auth maintenance is expensive. | Stop if it needs broad cookie/key collection or cannot meet the same account/provenance rules as Codex. |
| **Defer** | Generic multi-provider adapters, iCloud personal sync, widgets, Linux desktop, 21-language parity, broad incident polling. | These are CodexBar strengths, but they are poor early TiboTattle wedges. | Revisit only with a measured audience need and a maintainable source/consent model. |

## Decision gates

### Use CodexBar when

- the user needs multiple providers, accounts, credentials, and status in one
  always-on menu bar;
- a reset alert, status badge, widget, terminal hook, or Linux CLI matters more
  than accounting provenance;
- a stable signed public binary is a prerequisite today.

### Build TiboTattle when

- a user needs a defensible answer about their Codex allowance, local work, and
  API-price-equivalent cost rather than a generic meter;
- raw agent data must stay local by default;
- optional aggregate research/community benefit must be visibly consented,
  content-free, reviewable, and deletable.

### Stop or defer an expansion when

- it requires storing or importing browser cookies/API keys merely to compete
  on a provider-count scorecard;
- it would report a quota/cost/forecast number with no account, reset, price,
  or freshness provenance;
- a feature can be obtained directly from CodexBar with no material TiboTattle
  advantage.

## Validation completed and limits

Completed during this audit:

- pinned CodexBar remote `main` and inspected the public repository, current
  release, provider, refresh, status, CLI, architecture, and release docs;
- reviewed the TiboTattle active source, product documentation, native shell,
  local companion/dashboard, provider adapters, privacy/contribution surfaces,
  packaging scripts, and current dirty-worktree boundary;
- passed the focused source test:

  ```text
  node --test --test-concurrency=1 --test-name-pattern='menu-bar status item|menu-bar status|native menu' test/macos-app-bundle.test.js
  # 1 pass, 0 failures
  ```

- current-source targeted suites reported by the independent local inventory:
  `npm run product:ui:test` **130/130**, `npm run product:local:test`
  **135/135**, and focused provider/core coverage **101/101**. These validate
  source contracts in the active dirty worktree, not a public release;

- after the forecast files appeared in the active worktree, the repeat focused
  forecast/UI check passed **12/12**:

  ```text
  node --test --test-concurrency=1 test/shared-quota-pace-forecast.test.js apps/web/test/weekly-pace-forecast.test.mjs
  ```

- passed the packaged Mac menu-bar contract smoke, which instantiates a native
  AppKit status item/menu and checks native rows, titles, start/unavailable
  states, `Cmd-R`, `Cmd-,`, `Cmd-Q`, and native/Escape/deactivation dismissal;
- inspected the installed preview metadata. A second launch correctly hit the
  single-instance local-data guard, so no visual claim about the full dashboard
  was made from that conflicting instance.

Not established by this audit:

- live success for every CodexBar provider/auth strategy or every release-note
  feature;
- live Google/Apple contribution sign-in, upload, deletion, or public
  community publication for TiboTattle (the Worker/R2 deployment remains a
  source/contract surface, not a checked public service);
- a Developer-ID-notarized TiboTattle installer or live update/rollback
  journey; and
- visual dashboard/menu QA from a fresh, non-conflicting signed TiboTattle
  install, including the new pace-card surface.

## Primary evidence

- [CodexBar repository and current feature catalogue](https://github.com/steipete/CodexBar)
- [CodexBar v0.47.0 release notes](https://github.com/steipete/CodexBar/releases/tag/v0.47.0)
- [CodexBar provider documentation (pinned)](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/providers.md)
- [CodexBar provider authoring architecture (pinned)](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/provider.md)
- [CodexBar refresh model (pinned)](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/refresh-loop.md)
- [CodexBar status model (pinned)](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/status.md)
- [CodexBar CLI documentation (pinned)](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/cli.md)
- [CodexBar update/release documentation (pinned)](https://github.com/steipete/CodexBar/blob/94efcfdf4a4be495ddc80ad5193d4e488df06450/docs/sparkle.md)
- [TiboTattle product README](../../README.md)
- [TiboTattle product reference](../reference/product-reference.md)
- [TiboTattle native lifecycle/release runbook](../../apps/macos/README.md)
- [TiboTattle product brand and deliberately Codex-specific target](../../config/product-brand.js)
- [TiboTattle Codex app-server boundary](../../src/providers/codex/app-server.js)
- [TiboTattle menu-bar controller](../../apps/macos/Sources/MenuBarStatus.swift)
- [TiboTattle native application and menu smoke](../../apps/macos/UsageMonitorApp.swift)
- [TiboTattle quota-analysis package](../../packages/quota-analysis)
