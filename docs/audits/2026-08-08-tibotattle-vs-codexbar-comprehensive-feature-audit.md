---
title: TiboTattle versus CodexBar comprehensive feature audit
date: 2026-08-08
type: review
status: completed
---

# TiboTattle versus CodexBar comprehensive feature audit

## Executive decision

CodexBar and TiboTattle are adjacent products, not interchangeable builds of
the same product.

- **Use CodexBar** when the job is a mature, always-on cockpit for many AI
  providers, accounts, limits, resets, incidents, spend, widgets, and
  automation.
- **Continue building TiboTattle** only as a specialist Codex evidence
  instrument: event-time API-price-equivalent accounting, allowance
  calibration, matched/excluded evidence, residuals, uncertainty, and an
  optional research/community path.
- **Do not fork CodexBar and do not enter a provider-count race.** CodexBar's
  released 67-provider surface, credential matrix, platform distribution, and
  maintenance velocity would turn TiboTattle into a permanently lagging clone.
- **Do not position TiboTattle as merely “CodexBar with more charts” or as
  categorically more private.** CodexBar now has substantial local cost
  history, charts, pace, share cards, plugins, and a web dashboard. TiboTattle's
  local-only mode has the narrower credential boundary, but its optional
  full-history hosted contribution creates a different and material
  longitudinal privacy risk.

The source-visible TiboTattle wedge is plausible, but it is not yet validated
by a same-corpus comparison or prospective reset calibration. Any
contribution-enabled public release should be blocked on two P0 boundaries: a
stable signed distribution and an enforced, reconciled v1
collection/consent/publication contract. A signed local-only app 0.1.0 release
is a viable narrower lane if contribution UI, v1 pairing/ingest, and the daily
builder are hard-disabled and a no-egress check proves the boundary.

## Critical finding before the feature matrix

TiboTattle's current v1 contribution implementation is ahead of, and conflicts
with, its public privacy promises and governing documents:

1. The root README promises review of the “exact retained metadata,” while the
   current UI asks once for consent to a *kind* of data and then uploads full
   history plus roughly six-hour deltas without per-batch review.
2. The visible first-run review shows coverage time, item count, and byte size;
   it does not show representative records or the complete field-level
   retention/linkability consequence.
   The public privacy page also describes bounded observations “rather than”
   personal dashboard history, while the current UI explicitly promises a
   first upload of full usage history; that distinction is materially
   ambiguous even though prompt and response content are excluded.
3. The v1 design is still marked `proposed` and is internally contradictory:
   its main decision list specifies an HMAC session pseudonym, while an appended
   “RESOLVED” note switches to the raw provider-issued Codex session UUID and
   deletes pseudonym machinery. Current source follows the appended note. The
   older active privacy contract says raw session identifiers are prohibited.
4. The public privacy page promises delayed, capped, rounded, thresholded
   community output. The v1 daily builder creates revisioned daily rows labelled
   `suppression: none_daily_grain_by_owner_decision`, including participant and
   device counts plus token totals and model cells.
5. A focused v1 companion-route test fails reproducibly, and that file is not
   included in the otherwise-green `product:local:test` gate.
6. Live health describes v1 external participation as unauthorized, but current
   source does not use that field as an enforcement gate: an authenticated
   v0.1 participant can request v1 device consent and the upload dispatcher can
   accept v1 envelopes. The scheduled daily builder also runs under the general
   publication control.
7. Hosted deletion explicitly covers v1 chunks and R2 objects, but the current
   participant export, profile totals/history, and personal-stats handlers read
   only synthetic and/or legacy telemetry. No complete v1 participant account
   surface is implemented or proven.

This is high severity because it changes what informed consent, data
minimization, collection authorization, and safe publication mean. There is no
evidence in this audit that the unsuppressed daily rows are publicly exposed:
the public route still returns a suppressed weekly snapshot with no cells.
That is narrower than proving a safe live boundary. Because the health field is
descriptive rather than an effective kill switch, this audit cannot rule out
central v1 ingestion or storage; production D1/R2 state must be inventoried.

## Scope, snapshots, and evidence grades

This audit refreshes and supersedes the
[August 3 comparison](./2026-08-03-tibotattle-vs-codexbar-feature-audit.md).
It compares product capability, evidence quality, privacy boundaries,
operability, and release maturity. It does not claim successful live access to
every supported provider account.

| Grade | Meaning |
| --- | --- |
| **Release** | Present in a tagged public release or its release notes/assets. |
| **Main** | Present only in the pinned upstream `main` snapshot; not a released claim. |
| **Checkout** | Present in the pinned TiboTattle source checkout. |
| **Test** | Freshly exercised contract or test evidence; scope is only the named contract. |
| **Installed/live** | Observed in an installed bundle, rendered UI, running process, or public endpoint. |
| **Not verified** | Documentation/source claim not exercised end to end in this audit. |

### Pinned snapshots

- **CodexBar release:**
  [v0.48.1](https://github.com/steipete/CodexBar/releases/tag/v0.48.1),
  released August 8, 2026, dereferenced commit
  [`226085b80f2414346624fce7a3b794bda6c54087`](https://github.com/steipete/CodexBar/tree/226085b80f2414346624fce7a3b794bda6c54087).
  This is the stable comparison baseline.
  At the audit cutoff the repository API reported roughly 19,800 stars, 340
  contributors, 4,778 commits and 12,998 downloads of the current macOS zip.
  These are adoption/maintenance signals, not evidence that every integration
  is equally deep or reliable.
- **CodexBar main cutoff:**
  [`b4741e505dbad18cfc28fa9dc7e70faf512fde29`](https://github.com/steipete/CodexBar/tree/b4741e505dbad18cfc28fa9dc7e70faf512fde29),
  August 8, 2026 at 14:30:30 PDT. The release and main histories had diverged:
  38 main-only commits and one release-only commit. Main moved repeatedly while
  the audit ran, so every main-only claim is pinned and non-release.
- **TiboTattle checkout:** branch `codex/integrate-spark-exclusion`, commit
  `4a6d9b2cf86e493281976d57e9fa7693800075cb`, August 8, 2026 at 17:09:15 EDT.
  The worktree was clean before the audit artifact was added.
- **TiboTattle installed preview:** `0.1.0 (1)`, channel
  `preview_distribution`, arm64, macOS 13+, English/Spanish/Simplified Chinese,
  ad-hoc signed and rejected by Gatekeeper.
- **CodexBar installed reference:** the machine's app is older `0.46.0 (110)`,
  universal, Developer-ID signed, notarized, and stapled. It was used only to
  verify the product's installed interaction/distribution shape, never as proof
  of v0.48.1 behavior.

## What changed since the August 3 audit

The prior feature comparison is materially stale.

### CodexBar

Released v0.48.0/v0.48.1 added a built-in CLI web dashboard and stable
dashboard snapshot API, multi-account Claude cards, daily spend charts,
atomic snapshot output, an accessible token-activity heatmap, local JS/TS
provider plugins, expanded Fast pricing semantics, and multiple scanner,
cache, and UI hardenings. v0.48.1 repaired a v0.48.0 launch crash caused by
resource-bundle lookup and improved stale dashboard serving.

Pinned `main` goes further with Fireworks as provider 68, a transactional
SQLite Codex cost store, and QuickJS as the plugin engine across platforms.
Those are **Main**, not v0.48.1 release features.

### TiboTattle

Current checkout closes several former gaps: it now has a native dashboard,
login-item support, local allowance notifications, configurable foreground
refresh, three locales, a full-history unified SQLite index, cumulative drift,
and the v1 full-history incremental contribution implementation. The first six
are genuine progress. The contribution change creates the new P0 privacy and
contract reconciliation problem described above.

## Product fit under two different jobs

A single weighted score would hide the actual decision.

| Criterion | Specialist Codex allowance instrument | General AI quota cockpit | Directional lead today |
| --- | ---: | ---: | --- |
| Allowance-answer fidelity | 25% | 5% | TiboTattle design |
| Provenance, exclusions, uncertainty | 25% | 5% | TiboTattle |
| Privacy/trust boundary | 15% | 10% | Split by operating mode |
| Freshness, recovery, field reliability | 15% | 15% | CodexBar |
| Distribution maturity | 10% | 20% | CodexBar |
| Provider/account breadth | 5% | 25% | CodexBar |
| Glanceability, accessibility, automation | 5% | 20% | CodexBar |

Under the specialist weighting, TiboTattle has the stronger method but is
provisional until its contribution and public-release boundaries are repaired.
Under the general-cockpit weighting, CodexBar wins decisively.

## Comprehensive feature matrix

### Product, UI, and daily operation

| Capability | CodexBar | TiboTattle | Result |
| --- | --- | --- | --- |
| Primary job | **Release:** glanceable limits, resets, credits, costs, incidents, and account state across many AI providers. | **Checkout/installed:** explain Codex quota, replay-safe token/cost activity, inferred allowance, disagreement, and evidence quality. | Different jobs: cockpit versus forensic instrument. |
| Mac interaction | **Release:** menu-bar-only `LSUIElement`, no Dock icon, one item per provider or merged provider switcher. | **Checkout/installed:** foreground Dock app with native sidebar/detail window, plus a compact status item and loopback dashboard. | Preserve Tibo's explanatory workspace; do not copy menu-only architecture. |
| Menu bar | **Release/installed shape:** mature cards, provider/account switchers, layout tokens, icons, meters, pace, stale/error states, merged mode. | **Checkout/test/installed:** safe direct-Codex headline, native quota rows, stale/analyzing states, refresh/settings/about/quit, keyboard and dismissal contracts. | CodexBar leads in density and customization; Tibo's narrower truth boundary is appropriate. |
| Native dashboard | **Release:** Settings plus Usage & Spend; compact menu remains primary. | **Checkout/installed:** Overview, Allowance, Trends, How it works, Community in resizable native AppKit/WebKit shell. | Tibo leads in explanatory depth. |
| Browser dashboard/API | **Release:** `codexbar serve` UI and `/dashboard/v1/snapshot`, cached last-good responses, provider/detail queries, loopback default. | **Checkout/installed:** private loopback browser companion with fixed routes and host/peer checks; no stable consumer-facing remote schema. | CodexBar leads for supported automation; Tibo's loopback is product-internal. |
| Current quota/reset | **Release:** provider-specific session/weekly/monthly/credit windows, reset countdowns and classifications. | **Checkout/installed:** direct Codex primary and Spark lanes, reset/freshness/failure evidence with tracks kept separate. | Focused functional parity for Codex; CodexBar much broader. |
| Pace/run-out | **Release:** usage pace, projected run-out, predictive warnings, provider cadence handling. | **Checkout/test/installed:** bounded current-reset slopes/ETA, stale and incompatible refusal rules; allowance estimates are a separate calibrated quantity. | Overlap in UI answer, different semantics. |
| Refresh | **Release:** manual, fixed 1/2/5/15/30-minute, Adaptive, agent-aware Adaptive, low-power/thermal/menu-activity controls. | **Checkout/test:** manual and foreground 1/5/15/30-minute refresh; default 5; no work after quit. | CodexBar leads. Borrow power-aware coalescing, not process inspection, only after P0. |
| Launch at login | **Release:** normal menu utility behavior. | **Checkout/test/installed:** opt-in `SMAppService.mainApp`; no helper daemon, LaunchAgent, or privileged service. | Tibo has closed the old gap. Some docs remain stale. |
| Notifications | **Release:** quota/reset warnings, incident overlays and celebrations; hooks can automate transitions. | **Checkout/test/installed:** local-only and off by default; fresh direct-provider evidence only; threshold and schedule/reset dedupe. | Tibo closed the core local-alert gap; CodexBar remains broader. |
| Provider incidents | **Release:** OpenAI, Claude, Cursor, Factory, Copilot and Google service status surfaces where configured. | No general provider-status feed or incident overlay. | CodexBar lead. Add only if it explains a real local unavailable state. |
| Settings/customization | **Release:** provider/account/source, menu layout, refresh, notifications, cost, plugins, hooks, iCloud, icons and many display choices. | **Checkout/installed:** Codex home, refresh interval, login item, notifications, language, updater/about, contribution controls. | CodexBar lead. More settings are not automatically valuable to Tibo. |
| Share cards | **Release:** local cost/token/provider cards with identity and model-family safeguards. | **Checkout/test/installed:** 1200×800 allowance/activity/remaining/fit PNG, active filters, accessible transcript, random identity-independent reference, Save/Copy. | Mechanism parity; Tibo's claim/provenance is the distinction. |
| Accessibility | **Release:** extensive native menu, chart, widget, localization and keyboard coverage. | **Checkout/test:** VoiceOver menu labels, Settings labels, ARIA chart transcript, keyboard zoom/pan. | Good Tibo foundation; clean signed VoiceOver QA remains unproven. |
| Localization | **Release/source:** 23 explicit app languages, including Arabic and Persian RTL catalogs; the README is stale at 21. | **Checkout/test/installed:** English, Spanish, Simplified Chinese; machine-assisted, no shipped RTL locale. | CodexBar lead. Tibo has closed the English-only gap. |

### Providers, accounts, and data acquisition

| Capability | CodexBar | TiboTattle | Result |
| --- | --- | --- | --- |
| Consumer provider breadth | **Release:** 67 registered provider IDs. **Main:** 68 with Fireworks. | **Checkout/installed:** Codex is the supported consumer monitor. | Largest CodexBar lead. |
| Provider depth | **Release/source:** depth varies by provider and source; some expose percent windows, some credits/cost, some local history, some status. Persistent cross-provider Usage & Spend history is advertised for only six descriptors: Codex, Claude, Vertex AI, OpenAI, Mistral and Bedrock. | **Checkout:** one deep Codex-specific measurement model. | Do not equate ID count with uniform depth, but breadth is still decisive. |
| Data-source strategies | **Release:** OAuth/device flows, API keys, browser cookies/local storage, provider CLIs, known config files, local logs/databases, provider apps. | **Checkout:** Codex app-server plus known local Codex sessions/archives; Google/Apple only for optional contribution identity. | Tibo's narrow surface is a local-mode trust advantage. |
| Accounts and switching | **Release:** provider accounts, token accounts, Codex accounts, Claude-swap lists, grouping, switching and last-known remote snapshots. | **Checkout:** HMAC local account scope prevents unsafe mixing; no consumer account switcher or general multi-account workflow. | CodexBar for management; Tibo for refusal to pool ambiguous evidence. |
| Claude | **Release:** substantial Claude OAuth/CLI/web/admin/multi-account support. | **Checkout:** internal Claude export/statusline and Anthropic accounting building blocks, not a supported authoritative consumer dashboard. | Public claim must remain “Codex-first; Claude incomplete.” |
| Credential handling | **Release:** depending on source, restrictive JSON config, Keychain/cache, browser sessions, OAuth or external CLI credentials. | Local Codex analysis does not need a Tibo-stored provider API key or browser cookie. Optional hosted contribution uses sign-in and device credentials. | Different risk modes; Tibo should not import CodexBar's credential fan-out. |
| Source diagnostics/recovery | **Release:** detailed diagnose/config/source fallback and account recovery paths. | **Checkout/test:** evidence/refusal codes and one native companion restart, but no equivalent consumer diagnostics command. | CodexBar lead; a compact local diagnostics view is worth borrowing. |

### Token accounting, pricing, history, and inference

| Capability | CodexBar | TiboTattle | Result |
| --- | --- | --- | --- |
| Token components | **Release/source:** input, cached, output, reasoning and provider-specific detail where source supports them. | **Checkout/test:** uncached input, cache read/write, output text/reasoning/combined and context components with explicit availability. | Strong overlap for Codex. |
| Fork/replay handling | **Release/source/test:** fork catch-up, parent discovery, suffix resumes, subagent and ownership tests. | **Checkout/test:** persistent lineage snapshots, deterministic event keys, fork replay suppression and parser-version rescans. | Both are materially robust; same-corpus parity is still unmeasured. |
| Cost meaning | **Release:** provider billing/admin values where available and local API-price estimates where derived. | **Checkout:** explicitly `api_price_equivalent_not_subscription_allowance`; never claims provider billing or dollar allowance. | Tibo's semantic boundary is clearer for its narrow question. |
| Historical price basis | Released Codex local reports generally resolve stored token history against the current models.dev/fallback catalog at report time. | **Checkout/test:** event-time effective price schedule; missing time/model/tier/surface/components remain unpriced. | Tibo lead in historical price provenance. Totals may legitimately differ. |
| Fast/priority pricing | **Release:** model-specific estimated API Fast USD, models.dev-first ratios, fallbacks. | **Checkout/test:** explicit speed/tier/surface evidence and event-time Fast weighting; unknown mode stays unknown. | Strong overlap; compare exact corpus before parity claims. |
| History horizon | **Release:** Usage & Spend 7/30-day cost UI; CLI cost ranges up to 365 days; separately sampled plan-utilization history is capped at 17,520 hourly samples (about 730 days). | **Checkout/test/installed:** 24h/7d/30d/all indexed history and resumable full retained Codex corpus. | Tibo lead for full-corpus evidence depth; CodexBar already has substantial long-lived plan history. |
| Scanner durability | **Release:** bounded resumable JSONL scans and persistent cache. **Main:** transactional SQLite cost store, crash/scale/failure-preservation work. | **Checkout/test:** staged SQLite, integrity check, fsync/atomic rename, cursors, incremental append, parser stamps, malformed-line salvage and memory bounds. | Tibo lead versus released cache; current main narrows the gap. |
| Unknown/unpriced handling | **Release/source:** partial breakdown labels, unknown model behavior and data-confidence fields. | **Checkout/test:** refusal states and explicit unpriced/unobserved/partial coverage propagate into every estimate. | Tibo lead in central product semantics, not unique possession of unknown states. |
| Allowance valuation | No equivalent released cost-to-observed-quota capacity fit was found. | **Checkout/test/installed:** pairwise capacity estimates, evidence minimums, ranges, track continuity and reset separation. | Core Tibo differentiator. |
| Residual analysis | Usage pace and plan-utilization analysis, but no equivalent user-facing observed-minus-calculated residual/MAE/drift evidence workflow found. | **Checkout/test/installed:** observed versus expected, residuals, MAE, peak residual, cumulative drift, coverage and exact windows. | Core Tibo differentiator. |
| Validation/calibration | Mature usage/run-out logic, but not a claim of calibrated subscription-dollar equivalence. | **Checkout/test:** train/holdout checks, forecast error/bias and refusal gates; still needs prospective future-reset validation. | Tibo method lead; real-world calibration is not finished. |
| Method explanation | Provider/card/source documentation and diagnostic labels. | **Installed:** How it works page explains tokens, cost components, event-time prices, Fast weighting, allowance model and indexed coverage. | Tibo lead for the forensic journey. |

### Automation, extensibility, platforms, and release

| Capability | CodexBar | TiboTattle | Result |
| --- | --- | --- | --- |
| Consumer CLI | **Release:** usage, cost, dashboard, serve, diagnose, config, cache, guard, hooks, plugins and other operational commands. | Developer/research CLI and loopback internals exist; no polished stable consumer status/JSON contract. | CodexBar lead. A small read-only Tibo CLI is a later useful experiment. |
| HTTP/headless | **Release:** loopback default; non-loopback requires bearer token and explicit cleartext acceptance, with documented TLS proxy guidance. | Product companion binds loopback and is not a supported LAN/headless product. | CodexBar lead; Tibo should remain loopback-only by default. |
| Hooks/guards | **Release:** edge-triggered hooks/watch, quota/status transitions, guard workflows and JSON. | No comparable consumer hooks/webhooks. | CodexBar lead; defer until real demand. |
| Plugins | **Release:** approval-bound local JS/TS provider plugins with declared origins/settings, bounded host API and generic snapshots; macOS app/CLI in v0.48.1. **Main:** QuickJS across platforms. | No consumer plugin contract. | CodexBar lead. Do not build a generic Tibo plugin system now. |
| Widgets | **Release:** provider switcher, usage/history/metric/burn-down/combined widgets; provider coverage varies. | None. | CodexBar lead; defer. |
| iCloud/device sync | **Release:** opt-in private CloudKit sync of selected config/preferences/snapshots; secret sync is separately controlled; histories/cost ledgers/hooks/paths do not sync. | No personal-device sync. Hosted contribution is a different research path. | Do not add iCloud merely for parity. |
| Linux/cross-platform | **Release:** macOS app plus macOS and Linux glibc/musl CLI assets. | arm64 macOS preview. | CodexBar lead. |
| Public distribution | **Release:** universal signed/notarized/stapled Mac app, Sparkle feed, GitHub assets and package-manager route. | **Installed/live:** ad-hoc arm64 preview; stable appcast 404; public site says download coming soon. | Highest non-privacy Tibo gap. |
| Updater proof | Public recurring release/appcast path. | A documented private signed/notarized 1004→1005 dogfood update passed, but stable publication remains absent; current installed preview is ad hoc. | Private rehearsal is useful evidence, not public readiness. |
| License/source | MIT repository and active public issue/PR ecosystem. | Root MIT license; the source repository remains private. Product-reference text saying no license is stale, while its private-repository description remains current. | License parity; source availability, ecosystem and maturity favor CodexBar. |

### Privacy, contribution, and community

| Capability | CodexBar | TiboTattle | Result |
| --- | --- | --- | --- |
| Local-only default | **Release:** on-device by default; reads known locations only when related sources/features are enabled. | **Checkout/installed:** accountless personal analysis works offline through a bundled runtime and loopback companion. | Both support a local mode. Tibo's Codex-only mode has fewer credential surfaces. |
| Optional local permissions | Main app is not sandboxed; browser cookie/local-storage access, Full Disk for Safari, Keychain/config, helper CLIs, and process/command-line inspection for agent-aware mode. | Codex folder/app-server and local session metadata; Login Item and notifications only when enabled. | CodexBar has the broader local trust boundary. |
| Optional network surfaces | Provider APIs/auth, status, updates, optional iCloud, plugins, and optional cleartext LAN serve with explicit gate. No central CodexBar usage corpus was found. | Updates and optional sign-in/contribution to Tibo's central service; local analysis itself does not require the account. | Tibo contribution has the more consequential central longitudinal boundary. |
| Contribution consent | No analogous central contribution flow. | UI: approve data kind once, full history first, then roughly six-hour deltas; reapproval only for kind/destination drift. README/product reference still describe older exact/bounded review semantics. | **P0 contract drift.** |
| Transport identity | Provider credentials/account identities stay within configured CodexBar source flows; no Tibo-like corpus. | Current v1 source explicitly stores and transports raw provider-issued Codex session UUIDs, despite older HMAC/raw-ID exclusion promises. | **P0 minimization, consent and documentation mismatch.** |
| Public aggregation | No analogous public aggregate system found. | Existing public v0.3 weekly route uses delay, minimum cohort, clipping, rounding and suppression. New internal v1 daily rows deliberately have no per-day threshold. | **P0 policy split before any route switch.** |
| Hosted account lifecycle | Not applicable to a central corpus. | Session-gated deletion explicitly covers v1 chunks/R2 objects and triggers withdrawal/rebuild contracts. Current export, profile totals/history, and personal stats read synthetic and/or legacy telemetry only; no complete v1 participant account view/export is implemented or proven. | Deletion is a useful control; v1 participant access and account coherence remain P0 gaps. |
| Community evidence | None analogous. | Live aggregate currently suppressed because release policy is not met; zero public cells. | Honest fail-closed live behavior, not yet a useful community product. |
| Privacy posture | Larger credential/auth/device surface; no central full-history contribution path found. | Smaller local credential surface; larger optional longitudinal/linkability/differencing risk. | Neither product is categorically “more private.” Compare modes and data flows. |

Two CodexBar privacy-documentation details deserve explicit treatment. First,
manual API keys/cookies/token accounts can live as plaintext values in an
owner-only mode-`0600` JSON configuration rather than a universal encrypted
credential store; current StepFun auto-login also persists its password in
that configuration, contradicting the README's broad “no passwords are stored”
claim. Second, the built-in browser dashboard stores its bearer token and last
full identity snapshot in browser `localStorage`. Off loopback, `serve` is
plain HTTP: the explicit non-loopback gate and token are good safeguards, but
TLS still requires a reverse proxy.

## Provider inventory boundary

CodexBar v0.48.1's 67 released IDs are:

`codex`, `openai`, `azureopenai`, `claude`, `clinepass`, `cursor`, `opencode`,
`opencodego`, `alibaba`, `alibabatokenplan`, `qwencloud`, `factory`, `gemini`,
`antigravity`, `copilot`, `devin`, `zai`, `minimax`, `manus`, `kimi`, `kilo`,
`kiro`, `vertexai`, `augment`, `jetbrains`, `moonshot`, `amp`, `t3chat`,
`ollama`, `synthetic`, `openrouter`, `elevenlabs`, `warp`, `windsurf`, `zed`,
`perplexity`, `mimo`, `doubao`, `sakana`, `abacus`, `mistral`, `deepseek`,
`deepinfra`, `codebuff`, `crof`, `venice`, `commandcode`, `qoder`, `stepfun`,
`bedrock`, `grok`, `groq`, `llmproxy`, `litellm`, `deepgram`, `poe`, `chutes`,
`neuralwatt`, `clawrouter`, `longcat`, `sub2api`, `wayfinder`, `zenmux`,
`aiand`, `zoommate`, `xai`, and `notion`.

Pinned main adds `fireworks` for 68. The source registry is a count of
integrations, not a promise that every provider exposes the same quota, cost,
history, status, auth, account, or platform capabilities.

TiboTattle's supported consumer provider remains Codex. OpenAI/Anthropic
accounting and Claude export/statusline code are internal or research building
blocks, not evidence of a supported Claude or generic multi-provider product.

## Privacy-contract pressure test

### Consent and identity drift

The conflicting evidence is direct:

- [README privacy model](../../README.md#privacy-model) says optional
  contribution requires explicit review of the exact retained metadata and
  derived artifacts exclude raw identifiers.
- [Current contribution UI](../../apps/web/public/index.html) calls the action
  “Contribute anonymous usage data,” then says approval covers a data kind once,
  full history uploads, and deltas follow roughly every six hours.
- The review facts in that UI are time covered, item count, and byte size. They
  do not expose a representative record or field-level schema.
- The
  [v1 design](../design/2026-08-07-incremental-contribution-model.md) is still
  marked proposed and contradicts itself: the main owner-decision list uses an
  HMAC-based session pseudonym, while an appended “RESOLVED” note requires the
  raw provider-issued UUID and deletes the pseudonym machinery.
- [Current v1 chunk source](../../src/contribution/telemetry-v1-chunks.js)
  explicitly says `sessionUuid` is stored raw and intentionally allowlisted.
- [The unified index](../../src/local-unified-index.js) stores the provider UUID
  because source says it must travel raw. An adjacent older comment still says
  an export-secret HMAC is computed at send time.
- [The active v0.1 privacy decision](../governance/2026-07-24-telemetry-privacy-contract.md)
  is explicitly local-only, prohibits raw session identifiers, and requires a
  separately reviewed frozen upload contract. It cannot serve as the missing
  v1 contract.
- [The product reference](../reference/product-reference.md) still describes
  the superseded bounded prepared-set/first-reviewed-send model.

“Anonymous” is inaccurate. At minimum the system is pseudonymous: sign-in is
represented by a pairwise server identity, and stable raw provider session
UUIDs link events within sessions. The exact linkability and retention
consequence must be named before opt-in.

### Publication-policy split

The [public privacy page](../../apps/web/public/privacy.html) promises delayed,
capped, rounded output withheld until enough eligible accounts qualify. The
existing public weekly implementation enforces those controls.

The newer
[daily aggregate builder](../../apps/worker/src/community-daily-aggregates.ts)
does something materially different: revisioned daily rows carry no
suppression threshold and can include low-N participant/device counts and token
totals/cells. Migration
[`0031_incremental_contribution_v1.sql`](../../apps/worker/migrations/0031_incremental_contribution_v1.sql)
permits only `published` or `withdrawn` for those daily rows.

The public routing boundary still uses the older weekly policy, but collection
and internal materialization are not shown to be contained:

- [Central health](https://tibotattle.com/api/health) returned `200`, operational
  controls, accepted contract `telemetry-contribution-v0.1`, and v1
  `implementation_ready` with `externalParticipantsAuthorized: false`. Source
  inspection found this is health metadata, not a server-side authorization
  gate.
- [Public community insights](https://tibotattle.com/api/v1/community/insights)
  returned a v0.3 weekly snapshot with `releaseStatus: suppressed`, reason
  `privacy_release_policy_not_met`, and zero cells.
- Current source's public handler still reads the weekly snapshot. The daily
  reader is an internal database helper with no public route.
- [Current Worker source](../../apps/worker/src/index.ts) nevertheless lets an
  authenticated v0.1 telemetry participant request v1 ongoing device consent,
  dispatches v1 envelopes to the v1 ingest handler, and writes accepted chunks
  to D1/R2. No separate external-v1 enable flag was found on those paths.
- Hourly maintenance invokes the unsuppressed daily aggregate rebuild whenever
  the general publication control is enabled; keeping the public route weekly
  therefore does not prevent internal daily materialization.

Implement an effective server-side v1 kill switch, reject v1 pairing/ingest
while external participation is unauthorized, and stop the daily builder while
policy is unresolved. Inventory production v1 D1 rows, R2 objects, and daily
aggregates; if raw UUID-bearing data was accepted outside an approved boundary,
perform a scoped incident review and purge or migrate it as appropriate. Before
authorization, publish a frozen field-purpose/retention/linkability contract
and threat-model low-N days, dominance, differencing across late-data
revisions, and deletion withdrawals. Reinstate minimum
support/clipping/rounding/complementary suppression, or obtain explicit
independent approval for a genuinely different policy.

### Installed contribution-state coherence

The current installed Community page rendered an “Approved — your history
syncs automatically” stage while also rendering “Not signed in” and “Sign in
again … Nothing was uploaded.” That may reflect stale local approval plus a
lost hosted session, but the user-facing state is internally confusing. No
real sign-in, first full sync, watermark resume, delta, export, or delete was
performed in this audit.

## Quality and release maturity

### TiboTattle fresh validation

| Check | Result |
| --- | --- |
| `npm run product:ui:test` | **192/192 passed** |
| `npm run product:local:test` | **164/164 passed** |
| Focused unified-index/accounting/pace/localization run | **67/67 passed** |
| Worker v1/community focused run | **19/19 passed** |
| `test/contribution-v1-companion-routes.test.js` | **3/4 passed; 1 failed** (`controller.calls.start` actual 1, expected 2) |
| Packaged menu-bar contract smoke | Passed |
| Packaged quota-notification smoke | Passed |
| Packaged refresh-settings smoke | Passed |
| Packaged native-dashboard-layout smoke | Passed |
| Packaged updater contract smoke | Passed, `feed_unverified` |
| Packaged login-item contract smoke | Passed |
| Packaged first-run contract smoke against the already-onboarded real profile | **Not established:** exited 1 because the contract correctly requires no prior first-run receipt; this is not evidence of an onboarding defect |

The reproducible 67-test command was:

```sh
node --test --test-concurrency=1 test/local-unified-index.test.js test/replay-safe-accounting-cache.test.js test/weekly-pace-refresh-integration.test.js test/localization-system.test.js test/macos-localization.test.js
```

The v1 route failure is a test/implementation contract mismatch, not enough by
itself to prove a runtime defect. It is nevertheless a release-gate problem
because the dedicated file is omitted from `product:local:test`. Fix the
contract and add the file to a required lane.

No full-repository `npm test` pass is claimed. An independent inventory started
that broader run and stopped it after roughly three minutes for bounded audit
handoff; all passing counts above are the exact named product/focused lanes.

The installed UI was visually inspected page by page. Overview, Allowance,
Trends, How it works, Community, General Settings, Notifications and About all
rendered. No private usage amounts or identifiers are recorded in this audit.

The installed bundle is internally hash-manifested and contains the pinned
runtime/resources, but it does not embed the Git commit. Its manifest records
`preview_distribution`, ad-hoc signing, no background upload addition, and a
bundle payload/inventory SHA-256 rather than a Git revision. Exact
source-to-binary provenance therefore remains inferred.

### CodexBar fresh validation

- The v0.48.1 checkout built under Apple Swift 6.3.3/Xcode 26.6. Focused
  registry, CLI web-dashboard and user-plugin suites passed **21/21**.
- During the audit, upstream main briefly failed to compile under Swift 6.3.3
  because new Fireworks expectations used incompatible syntax and a scale-test
  fixture had drifted from a changed initializer. Upstream repaired both within
  minutes; at the pinned cutoff the directly affected Fireworks/SQLite suites
  passed **12/12**.
- Pinned main's site locale validator passed its current locale/message set.
- Pinned main is not release-clean: SwiftFormat 0.61.1 reports seven formatting
  errors in two Fireworks files, and `CHANGELOG.md` still contains a literal
  `>>>>>>>` conflict marker. Those are main-branch hygiene findings, not defects
  in released v0.48.1.

CodexBar's provider claims remain source/release inventory, not 67 live account
tests. No browser cookies, API keys, OAuth sessions, provider writes, or remote
account changes were used during this audit.

## Material TiboTattle documentation drift

At least these statements need a truth pass:

1. The August 3 comparison predates the native dashboard, Login Item,
   notifications, three locales, unified index and v1 contribution model.
2. `apps/local/README.md` still says there is no Login Item.
3. `apps/local/README.md` and `docs/reference/product-reference.md` chiefly
   describe the legacy v0.1 bounded prepared-set flow, not the primary v1
   full-history approve-once model.
4. The root README's “exact retained metadata” review and raw-identifier
   exclusion do not match current v1 transport.
5. The root README says notifications live under General, while the installed
   app has a dedicated Notifications pane; its reset-alert limitations also no
   longer match the schedule fallback implementation.
6. The active v0.1 privacy record is not a frozen v1 upload/privacy contract.
7. The v1 design remains `proposed` and contradicts itself: its main decision
   list describes HMAC session identity, while an appended resolution and the
   implementation use the raw UUID.
8. `src/local-unified-index.js` contains mutually inconsistent comments about
   HMAC-at-send versus raw UUID transport.
9. The public “anonymous usage data” wording should be “pseudonymous usage
   metadata” with the exact stable identifiers and linkability disclosed.
10. The public privacy page's bounded-observation/dashboard-history distinction
    does not clearly disclose v1's full-history, chunk bounds, cadence and
    exclusions.
11. The product reference says no license was selected, but the root repository
    now has an MIT license.
12. Installed build provenance records a bundle payload/inventory digest but
    not a Git revision.

## Prioritized action plan

### P0 — contain v1 and establish releasable boundaries

1. **Add an effective server-side v1 kill switch now.** While external v1 is
   unauthorized, reject v1 device pairing/consent and v1 envelope ingest, and
   stop the unsuppressed daily builder—not merely its public route. Keep the
   weekly suppressed route.
2. **Inventory production collection state.** Account for `telemetry_v1_*` D1
   rows, R2 `telemetry/v1-*` objects, and `community_daily_aggregates`. If any
   raw UUID-bearing v1 data arrived outside an approved boundary, perform a
   scoped incident review and purge or migrate it as appropriate.
3. **Minimize transport identity.** Default to a keyed, per-device contribution
   pseudonym such as HMAC and remove raw provider UUID storage added solely for
   transport; migrate or purge existing rows. Retain a raw UUID only if a
   demonstrated methodological necessity and explicit independent privacy
   review approve that materially different contract.
4. **Create and review a frozen v1 privacy/consent contract.** It must name the
   operator/destination, full-history scope, expected duration/volume, stable
   pseudonym and linkability, field purposes, retention, research/public
   outputs, participant access/export, deletion, and reapproval conditions.
   Extend participant export, profile history/totals, and personal stats to the
   complete retained v1 record set before external authorization.
5. **Choose one publication policy.** Prefer restoring minimum support,
   clipping, rounding and complementary suppression. If a no-threshold daily
   policy is intentional, require an explicit independent privacy review and
   document the materially different risk.
6. **Make the UI and documents tell the same truth.** Show representative
   metadata/schema, not only counts, and replace “anonymous.” Resolve the
   Approved/Not-signed-in state model.
7. **Ship real stable Mac release proof.** Embed source revision; build the
   intended arm64 Developer-ID binary; notarize/staple; pass Gatekeeper on a
   clean profile; validate stable-feed correctness and rehearse a
   production-channel update plus rollback. The current stable appcast is 404;
   verify an actual public N→N+1 separately after the first stable release.
8. **Keep a narrower local-only release lane available.** A signed app 0.1.0 can
   ship before the community system if contribution UI, v1 pairing/ingest, and
   daily building are hard-disabled and a clean no-egress check proves that
   local analysis stays local.

### P1 — prove the specialist product

1. Fix the v1 companion-route contract and include its test in a required
   product lane.
2. Run a same-corpus TiboTattle/CodexBar accounting comparison over forks,
   subagents, archived sessions, Fast/priority, unknown models and price
   schedule changes. Publish reasons for every difference, not only totals.
3. Run stationary-input/no-new-log baselines for refresh/index/quota drift and
   prospective future-reset holdouts for allowance slopes and residuals.
   Until these two measurements pass, label the specialist release
   experimental rather than claiming a validated accuracy lead.
4. Publish a user-readable network/data-flow map and packet-capture proof for
   local-only and contribution modes.
5. Only after the P0 privacy boundary is implemented, perform one privacy-safe
   end-to-end v1 dogfood journey: sign in, informed consent, first sync,
   measured duration/bytes/energy, interruption/resume, six-hour delta, export,
   profile/personal-stat reconciliation, deletion, aggregate withdrawal and
   no-resurrection.
6. Correct the documentation inventory above and preserve one source-of-truth
   product reference.

### P2 — borrow narrowly from CodexBar after P0/P1

1. Add one-click source/account diagnostics and mismatch recovery.
2. Add power/thermal/menu-aware refresh coalescing without process-list
   inspection.
3. Define a small, stable, read-only local JSON/CLI health surface with explicit
   source, account scope, freshness, exclusions and confidence.
4. Consider optional provider-incident context, clearly separated from quota
   evidence.
5. Only then trial an optional CodexBar plugin/adapter that displays one
   provenance-labelled Tibo headline. Do not share credentials or raw logs.

### Explicitly defer

- generic provider adapters and credential routing;
- browser-cookie, hidden-WebView, Full Disk and API-key fan-out;
- widgets, iCloud personal sync, LAN serving and executable hooks;
- Linux desktop and broad settings expansion;
- a generic plugin ecosystem;
- a menu-only/no-Dock redesign; and
- provider-count or feature-count positioning.

## Stop/use/contribute/wrap/build decision

| Option | Decision |
| --- | --- |
| **Use** | Use CodexBar for a broad multi-provider cockpit today. |
| **Build** | Build TiboTattle's Codex-specific evidence, calibration and residual-analysis product after clearing the release/privacy gates and validating the gap with same-corpus and prospective measurements. |
| **Contribute** | Upstream generic fork/replay fixtures, scanner corrections or provider-neutral accounting fixes when they are truly shared. |
| **Wrap** | Trial only a sanitized read-only status adapter after Tibo has a stable schema and release; do not make CodexBar a core dependency. |
| **Fork** | Do not fork CodexBar. |
| **Stop** | Stop any plan to market TiboTattle as a generic private menu-bar quota monitor or “CodexBar plus charts.” |

## What this audit did not establish

- live success of all CodexBar provider/auth/account strategies;
- a same-corpus numerical comparison between the two scanners;
- provider-authoritative dollar value for a Codex subscription allowance;
- prospective calibration of TiboTattle allowance ranges across future resets;
- a current public signed TiboTattle install/update/rollback path;
- a complete v1 contribution, resume, export, deletion and aggregate rebuild;
- a completed full-root `npm test` run;
- a clean-profile installed first-run contract smoke;
- privacy comprehension by new users; or
- human-certified TiboTattle translations and clean-profile accessibility QA.

## Primary evidence

### CodexBar

- [v0.48.1 release](https://github.com/steipete/CodexBar/releases/tag/v0.48.1)
- [Live repository metadata API at audit time](https://api.github.com/repos/steipete/CodexBar)
- [Latest release metadata and asset counts](https://api.github.com/repos/steipete/CodexBar/releases/latest)
- [v0.48.1 pinned tree](https://github.com/steipete/CodexBar/tree/226085b80f2414346624fce7a3b794bda6c54087)
- [Pinned main cutoff](https://github.com/steipete/CodexBar/tree/b4741e505dbad18cfc28fa9dc7e70faf512fde29)
- [Released README and feature/privacy catalogue](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/README.md)
- [Released provider/source matrix](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/providers.md)
- [Released Codex source and scanner boundary](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/codex.md)
- [Released plugin authority model](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/plugins.md)
- [Released dashboard API and threat model](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/dashboard-api.md)
- [Refresh policy](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/refresh-loop.md)
- [Status providers](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/status.md)
- [Widgets](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/widgets.md)
- [Configuration and iCloud boundary](https://github.com/steipete/CodexBar/blob/226085b80f2414346624fce7a3b794bda6c54087/docs/configuration.md)

### TiboTattle

- [Product README](../../README.md)
- [Product reference](../reference/product-reference.md)
- [Codex app-server source](../../src/providers/codex/app-server.js)
- [Unified local index](../../src/local-unified-index.js)
- [Unified index ingestion](../../src/local-unified-index-ingest.js)
- [Accounting ledger](../../packages/accounting/src/cost-ledger.js)
- [Quota calibration](../../packages/quota-analysis/src/quota-calibration.js)
- [Quota pace forecast](../../packages/quota-analysis/src/quota-pace-forecast.js)
- [Native app](../../apps/macos/UsageMonitorApp.swift)
- [Menu-bar controller](../../apps/macos/Sources/MenuBarStatus.swift)
- [Quota notifications](../../apps/macos/Sources/QuotaNotifications.swift)
- [Current contribution UI](../../apps/web/public/index.html)
- [v1 chunk transport](../../src/contribution/telemetry-v1-chunks.js)
- [v1 incremental contribution design](../design/2026-08-07-incremental-contribution-model.md)
- [Active v0.1 privacy contract](../governance/2026-07-24-telemetry-privacy-contract.md)
- [Daily aggregate builder](../../apps/worker/src/community-daily-aggregates.ts)
- [Daily aggregate migration](../../apps/worker/migrations/0031_incremental_contribution_v1.sql)
- [Private updater rehearsal](../receipts/2026-08-05-internal-dogfood-1005-update-rehearsal.md)
