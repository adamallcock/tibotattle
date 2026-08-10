---
title: Native-First macOS Client Migration Plan
date: 2026-08-03
type: plan
status: proposed
owners: [product, macos, local-companion]
---

# Native-First macOS Client Migration Plan

## Decision

Replace the local dashboard's hybrid AppKit-plus-`WKWebView` primary surface
with a native macOS client. The target is **SwiftUI for presentation**, a small
**AppKit integration layer** for macOS-only lifecycle features, and the existing
**Node local companion as the sole owner of analysis and privacy-sensitive
business logic**.

This is not a rewrite of parsing, accounting, pricing, calibration, local
caching, contribution preparation, or the central service. It is a replacement
of the local presentation and interaction boundary.

The public web surface remains a browser experience for installation,
fixed/cached privacy-reviewed community aggregates, support, and hosted flows.
It must never become a remote proxy for a person's raw local dashboard.

## Red-team disposition

Four independent engineering reviews examined the first draft for plan
completeness, ownership/maintainability, test/release rigor, and performance.
They found the architecture direction sound but blocked implementation on
several missing contracts. This revision resolves those blockers before any
subagent receives a code lane:

- a real local-native threat model and per-launch session capability;
- a strict snapshot revision, refresh-operation, payload-budget, and lifecycle
  contract;
- one source-set/build contract between Swift tests and the shipped launcher;
- a browser-conformance lane, rather than leaving browser normalization as a
  second pricing/freshness authority;
- a complete command inventory, hosted-flow topology, and Data & privacy lane;
- reversible preview rollout, installed upgrade/rollback rehearsal, bounded
  diagnostics, reproducible visual QA, and performance release gates; and
- an explicit serial integration lane that owns the composition root, package,
  build, CI, and localization files that parallel feature lanes cannot safely
  share.

The companion audit report and finding disposition are recorded in
[`2026-08-03-native-first-macos-plan-red-team.md`](../audits/2026-08-03-native-first-macos-plan-red-team.md).

## Why this migration is necessary

The current product has two UI owners for one user journey:

- `apps/macos/UsageMonitorApp.swift` provides `NativeDashboardChrome`, a custom
  header, sidebar, refresh control, native route enum, and a `WKWebView` host.
- `apps/web/public/index.html`, `app.js`, `navigation.js`, and `styles.css`
  still own the actual pages, hash routing, refresh/render lifecycle, and much
  of the visible dashboard state.

The native layer hides portions of the browser surface and injects hashes into
the page. That causes visible contradiction: the native sidebar can select a
page that the browser has not actually rendered; native freshness can say
"Up to date" while the document remains stale; and the window title area is
native but visually blank while a second, custom header appears below it.

This is structural, not a CSS defect. More bridge code would increase the
number of places that own selection, timing, loading, error, and accessibility
state.

## Product and privacy invariants

Every migration increment must retain these properties.

1. **Local first.** Raw logs, prompts, responses, commands, file paths,
   account identifiers, and credentials stay inside the local companion.
2. **One accounting authority.** `packages/accounting`, replay-safe local
   aggregation, historical price provenance, calibration, and contribution
   projection remain JavaScript/Node responsibilities. Swift only formats and
   renders values supplied by the safe dashboard contract.
3. **One refresh authority.** The local companion owns refresh mutual
   exclusion and work. The native client owns foreground scheduling and displays
   the companion's state. A browser refresh loop must not run while the native
   app is the active personal-dashboard surface.
4. **One route authority.** A typed native route drives the visible native page;
   it must not be translated into a browser hash for primary navigation.
5. **One snapshot for all native displays.** Main window, menu bar, share card,
   and accessibility representations derive from one versioned,
   content-free snapshot and shared chart series.
6. **Hosted identity remains isolated.** Google and Apple identity, callback,
   polling, and contribution transport remain service/companion-owned. An
   isolated browser or `WKWebView` may remain for this flow until native parity
   is demonstrably complete; the native dashboard must not absorb credentials
   or OAuth implementation logic.
7. **No release fiction.** A developer build, preview app, signed application,
   updater appcast, Worker deployment, and end-to-end external identity journey
   are independently verified release surfaces.
8. **A loopback port is not a hostile-local-process boundary.** The protected
   native protocol defends against network access and accidental/untrusted
   browser-origin use. It does not claim to defend against a malicious process
   already executing as the same macOS user. Secrets never enter a URL, log,
   database, diagnostics record, web document, or browser fallback.

## Target architecture

```text
macOS application
├── SwiftUI dashboard
│   ├── NavigationSplitView and native page views
│   ├── native cards, tables, charts, empty/loading/error states
│   ├── Settings and About views
│   └── share-card rendering from the same chart series
├── AppKit integration boundary
│   ├── application/window lifecycle and NSStatusItem
│   ├── Sparkle and update preference bridge
│   ├── app links, external browser and hosted-auth handoff
│   ├── keychain, diagnostics, save panels and alerts
│   └── bundled companion process lifecycle
└── LocalDashboardClient and LocalRefreshCoordinator
    └── private, capability-scoped loopback contract
        └── Node local companion
            ├── Codex discovery, parsing, checkpoints and SQLite/cache
            ├── replay-safe accounting and event-time price registry
            ├── calibration, confidence/evidence and safe projections
            ├── contribution preparation/queueing and central-service relay
            └── browser fallback/static public-local assets
```

### Native presentation

The main window is a normal titled, closable, minimizable, resizable macOS
window. It uses the system titlebar/traffic lights and a real toolbar, rather
than a blank title area plus a hand-drawn header inside the content view.

The main presentation is a `NavigationSplitView` with a single selected
`DashboardRoute`:

- Overview
- Allowance
- Trends
- How it works
- Community
- Data & privacy

`Data & privacy` is a short explanation/consent surface, not an endless
technical report. Persistent state such as local-only status, freshness, and
refresh belongs in the native toolbar. It does not belong in a duplicated
dashboard header or the status menu.

The app will retain a native `NSStatusItem`/status menu as a compact companion:
current headline, freshness, update local usage, open app, settings, about,
and quit. The menu is not a second dashboard. It follows normal dismissal,
Escape, keyboard shortcut, focus, and window activation semantics.

### Native state and dependency boundary

Use a small group of explicit Swift types rather than allowing views to call
the loopback API directly:

| Type | Responsibility | Must not do |
| --- | --- | --- |
| `DashboardRoute` | One stable enum for sidebar, title, commands, deep links, and tests | Reference web hashes |
| `DashboardSnapshot` | `Codable` content-free DTO rendered by native screens | Reprice, aggregate, infer, or read files |
| `LocalDashboardClient` | Async decode of versioned local endpoints and mutations | Own UI state or retry policy |
| `LocalRefreshCoordinator` | Launch/foreground/manual scheduling and single observable refresh state | Reimplement companion mutual exclusion |
| `DashboardStore` | Main-actor observable snapshot, route, load/error/freshness state | Perform network/process work directly |
| `MenuBarStatusController` | Render a compact projection of `DashboardStore` | Independently classify data semantics |
| `HostedFlowCoordinator` | Present/observe isolated hosted identity and contribution flows | Store OAuth secrets or raw usage data |

For macOS 13 compatibility, the initial store should use
`ObservableObject`/`@Published` and Swift concurrency, not an OS-14-only
observation dependency.

### Companion contract

Create one canonical, atomic endpoint:

```text
GET /api/local/v1/dashboard
```

It returns a schema-versioned `DashboardSnapshot` containing only
privacy-safe, already-derived values. It is the source for native views and,
during the compatibility window, the legacy browser renderer. Existing split
endpoints can remain as temporary compatibility routes but must be documented
as deprecated and tested against the canonical snapshot until removal.

The production personal dashboard is native-only. A public browser page may
describe or download the app, but it does not render local personal usage. The
legacy browser dashboard is a preview-only rollback surface; it is not a
long-term production fallback.

The snapshot must include:

- schema and presentation version;
- availability, freshness, refresh-state, and user-action affordance fields;
- current allowance and reset information;
- event-time price-registry provenance, coverage, and any safe explanatory
  labels required to distinguish historical pricing from comparable-current
  display;
- chart-ready allowance-history and usage series, including dates, observed
  span, range, and explicit qualification/partial status;
- safe Overview, Allowance, Trends, How-it-works, and community/contribution
  projection fields;
- deterministic diagnostic reference and non-sensitive support hints;
- bounded **aggregate** token component counts and already-derived aggregate
  cost components, when needed by the How it works view;
- no raw log contents, prompt/completion/reasoning text, event-level token
  payloads, raw paths, account/identity identifiers, email/name, credentials,
  OAuth codes, filesystem metadata, or open-ended arbitrary labels.

Contract implementation must include:

- JSON Schema owned in a stable local-contract directory;
- exact-key/unknown-key rejection and a typed allowlist;
- JavaScript validation before server response;
- Swift `Codable` decoding with no permissive fallback to invented values;
- strict schema-major compatibility: a mismatched bundled client/companion
  shows an actionable unsupported-version error. Full negotiated compatibility
  is deferred until there is a real independently-updatable companion use case;
- golden JSON fixtures for normal, no-Codex, stale, partial, unknown-model,
  zero-data, failed-refresh, and hosted-service-unavailable states.

#### Snapshot ordering, refresh state, and budgets

Every snapshot includes an immutable ordering tuple:

```text
companionInstanceID + snapshotRevision + generatedAt + ETag
```

`snapshotRevision` is strictly increasing within one companion process.
`companionInstanceID` changes at companion restart. `DashboardStore` cancels
superseded fetches and accepts a response only when it is newer for the same
instance, or when a newly confirmed companion instance starts a new sequence.
Chart/share caches use the same tuple plus appearance and render size.

Refresh is a separate strict state object, not an inferred freshness label:

```text
operationID, phase, startedAt, deadlineAt,
snapshotRevisionAtStart, snapshotRevisionAtTerminal, terminalCode
```

The companion creates `operationID`; it remains the only authority that returns
`202`, `409`, cancellation, timeout, quick-result, final-result, or failure.
The native coordinator must not call a snapshot current until it observes a
terminal successful operation and a snapshot revision greater than the revision
at operation start. A 300-second companion deadline is not shortened by a
client-side 90-second polling loop.

The v1 snapshot schema has explicit presentation budgets. Initial maxima are
deliberately conservative and can only change with benchmark evidence:

| Value | v1 limit | Behavior when exceeded |
| --- | ---: | --- |
| Serialized snapshot | 1 MiB UTF-8 | return `resource_limited`, retain last verified snapshot |
| Any interactive chart series | 512 extrema-preserving points | server downsamples; includes source-point count and method |
| Share-card chart series | 96 points | server supplies a separate bounded projection |
| Categorical rows (models/surfaces/tools) | 50 rows each | deterministic top rows plus explicit `other` aggregate |
| String field | 512 UTF-8 bytes unless a tighter field rule applies | validation failure, never truncation that changes semantics |

Downsampling is server-side and deterministic: retain first/last plus min/max
extrema per bucket, preserve each qualification transition, and retain the
source count/method so presentation never implies that a rendered point is a
raw measurement. The share card is generated only after an explicit request or
cache miss, coalesces obsolete jobs, and evicts its revision-keyed image cache
on memory pressure.

#### Native loopback authorization

The existing origin/header checks are not presented as a capability system;
they are only loopback/browser-origin controls. Before any native dashboard
uses v1, implement the following per-launch native session protocol for the
new protected local API:

1. The AppKit parent creates a cryptographically random 256-bit session token
   at launch.
2. It gives the token to the bundled Node child once over an inherited stdin
   pipe, then closes that pipe. The token is never passed as an argument, URL,
   environment value, preference, cache value, diagnostics value, or log.
3. The native `LocalDashboardClient` sends it only in an `Authorization` header
   over loopback (this does not claim that local HTTP is TLS). The Node server
   compares it in constant time and holds it only in process memory.
4. Protected native snapshot and mutation routes reject missing, forged,
   expired, replayed-after-restart, or wrong-instance credentials. The token
   rotates whenever the companion restarts or the application relaunches.
5. The pre-existing legacy browser route stays on a separate, read-only,
   browser-compatible contract only during the preview compatibility window. It
   never receives the native token. It is removed from the production personal
   dashboard at cleanup.

This gives the native app a meaningful capability boundary without claiming to
solve hostile same-user process compromise. A future JSON-RPC child-process
transport can be assessed separately; it is not required to block this
migration.

#### Refresh lifecycle and visibility policy

`LocalRefreshCoordinator` is the only native object allowed to begin, observe,
or cancel a companion refresh. `DashboardStore`, AppKit lifecycle callbacks,
the status menu, keyboard commands, and every page dispatch intent to that
coordinator; none may post directly to the companion.

The first release has deliberately narrow scheduling rules:

| App condition | Automatic behavior | Manual behavior | UI truth requirement |
| --- | --- | --- | --- |
| First visible dashboard after launch | Fetch snapshot; start one debounced refresh only if the snapshot is older than the freshness threshold | Refresh button remains available | Show cached data as cached until a terminal operation yields a newer revision |
| Visible and active | One debounced periodic eligibility check; it starts a refresh only when stale | Coalesces with active operation or explicitly offers cancel/retry | Main view and menu both project the same operation state |
| Hidden, closed, inactive, or asleep | Do not start new automatic work | A user action that reconstructs/activates the app may request refresh | Existing bounded companion work may checkpoint; no hidden UI is labelled current |
| Resume, wake, or window reopen | One foreground eligibility check after a short debounce | N/A | A newer revision is required before “Up to date” is displayed |
| Companion restart or capability rotation | Cancel obsolete client tasks; refetch under the new instance | Retried manual request starts once under new capability | Reset state visibly and never apply a response from the old instance |

The refresh state machine is tested with a controllable clock and process
double. Required paths are: quick result, long result, 202 polling, 409 active
operation, cancellation, 300-second timeout, app hide/reopen, sleep/wake,
companion restart, successive manual taps, and a stale snapshot that remains
stale after a failed refresh. A second periodic loop in browser JavaScript,
AppDelegate, or `MenuBarStatusController` is prohibited.

### Charts and share card

Use `Swift Charts` for native history charts on macOS 13. The native chart and
share card receive the same `AllowanceHistorySeries` from `DashboardSnapshot`.
No chart calculates implied allowance, price, bounds, or confidence in Swift.

The shared chart model must include:

- an explicit dollar axis with sensible tick selection and bounded visual
  domain padding;
- readable local-date x-axis labels with no mandatory horizontal scrolling at
  normal window sizes;
- points styled by explicit qualification state, including partial estimates;
- an accessible tabular equivalent plus focused value/range labels;
- a short user-facing explanation that range means observed reset variation,
  not a probabilistic confidence interval, only where that qualification is
  needed;
- identical numerical values and provenance between the dashboard and a
  rendered share card.

### Hosted identity, contribution and public site

Keep identity and contribution implementation out of the native accounting
client:

- Google and Apple use the existing service-hosted browser callback flow for
  the Developer ID distribution. Native Apple authorization is explicitly out
  of scope unless a separate App Store/ad-hoc distribution track supplies the
  entitlement, provisioning evidence, and signed end-to-end validation.
- The first native release retains the proven callback topology: the isolated
  hosted page owns its opaque state and short-lived proof; the app link is a
  content-free wake signal; `notifyHostedSignInReturn()` dispatches
  `tibotattle:hosted-sign-in-return` to that same page; the page performs the
  approved relay/poll result check.
- Browser cancellation, timeout, callback completion, sign-out, service
  restart, and app relaunch each return the hosted page to a defined usable
  state. The native shell only presents or reactivates the isolated flow; it
  does not invent a second token store or replace the page's proof lifetime.
- The user sees a reviewable, content-free payload before submit and an
  actionable failure reason when submission cannot proceed.

During the first native releases, Community may embed a deliberately isolated
hosted-flow surface while the dashboard itself is fully native. It must have a
clear bridge contract: completion, cancellation, timeout, sign-out, and
submission result events. It must not share raw personal dashboard data through
the web view.

The public website is restructured separately as a product introduction:
what TiboTattle is, a download/install path, fixed community aggregates, and
privacy explanation. It is not the local dashboard and does not issue arbitrary
personal-dashboard queries.

### Native command contract

Before a native control is exposed, its command is specified in the local
contract with method, request schema, response DTO, authorization requirement,
idempotency rule, cancellation behavior, terminal error codes, audit-safe
diagnostic code, and fixture. Commands are grouped as follows:

| Group | Commands retained for native use | Authority and special rule |
| --- | --- | --- |
| Dashboard | `dashboard.get`, `refresh.start`, `refresh.status`, `refresh.cancel` | companion creates operation IDs and terminal revisions; native never fabricates completion |
| Preferences | `fastModePreference.get/set`, `automaticContribution.get/enable/disable` | explicit user action; safe default and server-side validation only |
| Contribution | `contribution.preview`, `prepare`, `syncStatus`, `syncNext`, `syncOnce`, `pause`, `resume` | preview/prepare are content-free; reviewed submission remains idempotent and relay-owned |
| Device/recovery | `devicePair`, `deviceCredentialReset`, `syncInspectExact` | explicit destructive/confirmation model, bounded result only |
| Diagnostics | `diagnostics.note` | fixed code/field allowlist; never snapshot content or session token |
| Hosted identity | start/return/poll/sign-out/deletion | remains in the isolated hosted-flow contract for the first release, not a native loopback mutation |

Every protected command uses the per-launch session header. `refresh.start`
must return the command's `operationID`; `409` returns the active operation's
safe state rather than starting a second pass. One-time review/submission
commands include an opaque, expiring, server-validated review grant and must be
safe to retry without duplicate contribution. The implementation lane owns
strict positive and negative JavaScript/Swift fixtures for every retained
command before a native button is connected.

### Data & privacy lifecycle inventory

No navigation item or Settings tab may exist merely to restate that the product
is local-first. Every retained privacy/control journey has an owned surface,
safe command contract, and end-to-end acceptance test. The initial surface is
small: the main `Data & privacy` route explains the boundary and links to the
few actions below; it is not a dashboard-length report or a duplicate Settings
pane.

| User journey | Initial surface | Required behavior | Acceptance test |
| --- | --- | --- | --- |
| Understand local-only mode | Toolbar status plus `Data & privacy` summary | Explain in one screen what stays local and what can be opted into; no raw-data preview | Fresh install can reach explanation by keyboard and VoiceOver without sign-in |
| Inspect a potential contribution | Community native shell | Generate a bounded content-free preview with field categories and values, then require explicit review grant | Fixture proves prompt/path/identity fields cannot enter preview; user can cancel with no queue mutation |
| Enable, pause, resume, or disable automatic contribution | Privacy & contribution Settings section | One clearly labelled toggle plus queue status; disabling stops future work but does not silently delete submitted data | Persistence and restart tests; command is idempotent and explains retained queue state |
| Submit once | Community native shell plus isolated hosted identity page | Review first, sign in only when needed, submit exactly once or show retry-safe result | Google/Apple success/cancel/timeout/relaunch paths leave actionable UI; duplicate submit is prevented |
| Inspect/clear queued local contribution | Privacy & contribution Settings section | Bounded queue summary, explicit destructive confirmation, single clear outcome | Destructive confirmation is keyboard accessible; cancellation changes nothing; clearing does not touch raw Codex logs |
| Export or inspect diagnostics | Settings/Support action | Copy/export only allowlisted diagnostic references and state, never tokens or raw data | Content audit proves excluded fields are absent from export and retained log |
| Choose/reset Codex folder and recover companion access | General/Support Settings section | Security-scoped selection where required, local status, targeted reset confirmation | Missing install, revoked access, and reset fixtures retain prior safe state and explain recovery |
| Hosted account privacy/deletion | Isolated hosted page | Link to service-hosted deletion/privacy controls; native shell never owns the account token | Browser callback and sign-out/deletion return state is usable and no token crosses the native contract |

The implementation will remove the empty Settings “Privacy” page. It becomes a
real `Privacy & contribution` section only when these controls are wired; until
then the local `Data & privacy` route is the single explanatory surface.

### Build, update and localization foundations

The migration adds a native Swift module/test boundary without replacing the
existing bundle, signing, Node-asset, Sparkle, and validation pipeline in one
step.

1. Introduce `apps/macos/Package.swift` with a testable `TiboTattleCore`
   target that contains all native DTOs, stores, coordinators, page views, and
   chart/share presentation code. The direct AppKit launcher/Sparkle adapter is
   an intentionally small named allowlist outside that target.
2. Retain `scripts/build-macos-app.js` as the bundle assembler, resource
   collector, signing/updater integration, and release validator. It derives
   the `swiftc` source list from the Package target manifest plus that named
   launcher allowlist, and rejects a mismatch in source inventory, SDK,
   architecture, deployment target, Swift language mode, resources, SwiftUI,
   and Charts linkage. `swift test` and the shipped launcher therefore exercise
   one declared production source set rather than two drifting graphs.
3. Host SwiftUI in the existing AppKit application/window lifecycle first.
   Defer a top-level `SwiftUI.App` lifecycle rewrite until native views are
   stable; this avoids combining UI migration with Sparkle, menu-bar, keychain,
   and process-lifecycle risk.
4. Use one native localization boundary from the start. New UI strings live in
   `Localizable.strings` and format dates/numbers via the user's locale. Do not
   transliterate browser strings into Swift source.
5. Preserve preview versus production updater behavior and make the UI state
   truthful when no appcast has been published. A production updater release
   still requires its own signed/notarized/appcast gate.

`product:macos:test` becomes a required aggregate: source-set parity check,
`swift test`, native rendering/snapshot tests, current bundle/updater tests,
and the installed native-root smoke. CI may not silently omit any one of those
commands.

The project has three explicit build/test channels, so a human test does not
accidentally use a deliberately disconnected developer app:

| Channel | Intended use | External configuration | Must prove |
| --- | --- | --- | --- |
| Local fixture | Fast unit, contract, and deterministic visual tests | No production credentials; local fakes/fixtures only | Rendering, state machines, safe decoding, and failure presentation |
| Signed connected preview | Every manual human test during this migration | Explicit preview app identifier/app link, deployed central-service route, approved Google/Apple redirect settings, and preview appcast/R2 policy | Real companion, sign-in cancellation/success, contribution review/submit, updater behavior, and upgrade/rollback without publishing a production release |
| Signed production candidate | Release qualification only | Production identifier, signing/notarization, appcast, Worker/R2/service configuration | Exact public release journey and rollback evidence |

No build may label a disabled feature as testable. If a connected preview
dependency is absent, the UI names the missing configuration and provides a
stable diagnostic reference; it does not expose a real-looking button that
cannot complete. Secrets remain out of the repository and are injected only by
the existing secure build/deployment mechanism.

### Diagnostics and operational evidence

The migration defines a fixed native diagnostic event schema and a runbook
before wiring new failure states. Every event contains only: fixed diagnostic
code, build/channel, snapshot schema version, companion instance ID prefix,
operation phase, and minted support reference. It never contains a snapshot,
session capability, OAuth proof, account/identity data, raw log value, path,
or exception body. Events have existing bounded retention and user-visible
copy/export behavior.

The runbook records the required receipt for each preview or production test:
app bundle digest, build/channel, source-set parity result, companion/schema
versions, fixture set, test command results, screenshot matrix result,
diagnostic references, update/install/rollback artifact digests, and exact
external services intentionally exercised. This makes support correlation
possible without retaining personal activity.

## Delivery sequence

### Phase 0 — compatibility stabilizers

**Goal:** keep the present application usable while the native surface is
being built. This phase is deliberately small and does not add a new web/native
bridge layer.

- Fix the native `Trends` route/legacy browser alias mismatch.
- Make native manual/foreground refresh invalidate and replace the actually
  visible fallback report snapshot.
- Adopt the normal menu-bar-companion policy: traffic-light close and Cmd-W
  close the primary window but do not quit the app; Dock/status-menu Open
  reconstructs it; Cmd-Q performs the explicit quit path. A running refresh
  may finish its bounded safe checkpoint but no new automatic scan begins when
  no dashboard window is visible.
- Remove duplicate automatic browser polling when the native app owns the
  foreground dashboard.
- Add a temporary standard `NSToolbar` rather than expanding the custom content
  header.

**Exit gate:** installed preview shows the correct selected fallback page,
shows a refreshed timestamp after manual refresh, and obeys the exact
traffic-light/Cmd-W/Dock/status-menu/Cmd-Q behavior above.

### Phase 1 — contract and native foundation

**Goal:** establish the testable seam without changing the user-visible
dashboard numbers.

- Define `DashboardSnapshot v1`, command, refresh-operation, capability, and
  diagnostics schemas; fixtures; safe field/payload budgets; response
  validation; ETags; and revision semantics.
- Implement canonical atomic snapshot in the local companion.
- Move the legacy browser renderer onto strict canonical-snapshot decoding in
  this phase. It must delete browser-side pricing/freshness inference rather
  than preserve it as a second authority.
- Add Swift Package core, DTO decoding, `LocalDashboardClient`,
  `LocalRefreshCoordinator`, `DashboardStore`, and `DashboardRoute`.
- Build a hidden/native developer surface that renders fixtures before it
  connects to the companion.
- Migrate menu-bar status to consume the same snapshot/store projection.

**Exit gate:** JavaScript and Swift decode the same fixtures; protected routes
reject invalid/rotated credentials; no raw data leaves the companion; native
and legacy-browser snapshot values match; no second pricing or freshness
interpretation is introduced; and no out-of-order response can replace a newer
snapshot.

### Phase 2 — native personal dashboard vertical slices

**Goal:** replace the main report without changing the data engine.

1. Overview: current allowance, freshness, local setup/empty/error state, and
   clear primary actions.
2. Allowance: current seven-day evidence, historical pricing provenance, and
   readable explanation available on demand rather than as a wall of text.
3. Trends: native chart, accessible table, real date/tick layout, explicit
   partial-fit styling, and no mandatory x-axis scroll at standard widths.
4. How it works: concise, native disclosure groups for price coverage, token
   components/counts/costs, and model breakdown.
5. Data & privacy: an intentionally small, actionable local privacy surface
   with the detailed lifecycle inventory below; it does not reproduce an
   unbounded technical report.
6. Share: same history-series model rendered through `ImageRenderer`; one
   portable, source-safe image contract.

**Exit gate:** each native page matches a golden snapshot, has keyboard and
VoiceOver coverage, and passes rendered light/dark/large-text screenshot
comparison at minimum and common window sizes.

### Phase 3 — settings, community, and lifecycle

**Goal:** make the rest of the shipped app native where appropriate while
retaining isolated hosted flows.

- Native General, Updates, Privacy & contribution, and About settings views
  with real icons, a native logo treatment, meaningful controls only, and
  automatic updates defaulted as approved for production builds.
- Native menu bar with real menu-dismissal, Escape, action state, and app
  activation behavior.
- Native window commands: refresh, settings, sidebar toggle, close/hide,
  about, and quit.
- Community consent/review shell uses the safe snapshot; hosted sign-in and
  submission remains isolated until all cancellation/retry/callback paths pass.

**Exit gate:** user can complete or cancel all supported identity journeys
without a stuck button/state; contribution errors are actionable; Settings and
About contain no duplicated release/update prose.

### Phase 4 — preview qualification and native default

**Goal:** prove the native root in a real installed application before deleting
the legacy root.

- Introduce `DashboardPresentationMode`: `native`, `legacy`, and `automatic`.
  It is stored locally, visible in preview diagnostics, and accepts a
  documented launch override for recovery. It changes presentation only; no
  cache, identity, contribution, or accounting data is discarded.
- Preview builds default to native while retaining an explicit legacy rollback
  mode for one full preview compatibility cycle. Production does not expose a
  browser personal dashboard; it becomes native only after the preview gates
  below pass.
- Qualify update from a previous installed preview/release into the native
  default while preserving cache, Keychain, feature flag, companion launch,
  and safe snapshot rendering.
- Retain `WKWebView` only behind explicit hosted-flow/legacy-preview routes;
  retain browser assets required by public/hosted flows and bundle graph.

**Exit gate:** an installed preview passes the full native journey, an
upgrade/relaunch preserves state, legacy rollback is exercised from a retained
backup, and no primary native action depends on injected JavaScript, browser
hash navigation, or browser polling.

### Phase 5 — release qualification and cleanup

**Goal:** prove the installed product, not merely the source checkout.

- Build a clean preview application and use only
  `scripts/install-macos-preview-app.js` to stage, validate, replace,
  receipt, and preserve a recoverable `/Applications/TiboTattle.app` backup.
  Ad-hoc replacement commands are prohibited.
- Run a manual scripted journey: fresh launch, unavailable/no-Codex setup,
  refresh, native navigation, close/reopen, menu dismiss/Escape, settings,
  sign-in cancel/success, contribution review/submit/error, share, update
  check, and uninstall guidance.
- Test a real upgrade/rollback rehearsal only with signed artifacts: install
  the previous version, update through Sparkle or the signed DMG path, relaunch
  against existing state, verify cache/Keychain/feature flag/companion/native
  dashboard behavior, then restore the retained rollback artifact and verify
  the pre-upgrade state. Record both artifact digests in the release receipt.
- Test separate production gates only with production-configured signed
  artifacts: updater appcast, Apple/Google redirects, notarization, Worker,
  R2, and release-site download.
- Delete `NativeDashboardChrome`, primary report WebKit, injected native
  dashboard marker/hash bridge, and legacy v1 personal-dashboard routes only
  after the full release and rollback qualification succeeds. This is a
  separately reviewed cleanup change, not part of the first native-default
  rollout.

**Exit gate:** a clean installed application passes the release test matrix;
the local-first privacy boundary, bundle inventory, appcast policy, and public
site boundary remain verified.

## Parallel implementation swim lanes

No lane works directly in the shared dirty checkout. Before implementation, an
integrator creates a clean baseline branch that includes accepted event-time
pricing work as its own reviewed commit, records the baseline test result, and
gives every lane a dedicated worktree. A lane may change only its listed scope.
No lane changes accounting outputs, service credentials, production deployment,
or signing configuration without a separately authorized task.

### Preconditions and ownership rules

1. **Contract-first handoff.** Lane 1A publishes a reviewed schema, command
   table, golden fixtures, and versioned fixture package before an implementation
   lane makes a real network call. Swift/UI lanes may begin against an
   explicitly labelled fixture draft, but cannot merge against it.
2. **One composition owner.** Only lane 1F may edit the current app composition
   root (`UsageMonitorApp.swift`), existing `MenuBarStatus.swift`, build script,
   CI aggregate command, bundle resources, or the shared localization catalog.
   Feature lanes add new directories only. They submit proposed localization
   keys in their handoff; 1F integrates them atomically.
3. **One data authority.** Lane 1A may project existing accounting values into
   the snapshot, but may not change price selection, calibration, or token
   arithmetic. Any required accounting change is a separate reviewed work item.
4. **No synthetic success.** A fixture is sufficient for deterministic UI work,
   but only the signed connected-preview lane may claim real sign-in,
   contribution, updater, or upgrade behavior.
5. **Feature flags are presentation-only.** Preview rollback may select native
   or legacy presentation, never delete or transform caches, Keychain items,
   contribution queues, or historical pricing data.

### Parallel waves and swim lanes

| Wave / lane | Exclusive write scope and responsibility | May start / blocked by | Defined acceptance tests and handoff |
| --- | --- | --- | --- |
| 0A — Compatibility stabilizers | Narrow fixes in `apps/macos/UsageMonitorApp.swift` and the directly related legacy-route tests only: Trends alias, visible manual-refresh result, close/reopen semantics, stop duplicate browser polling | Immediately from approved baseline | Focused route and refresh tests; packaged smoke proving traffic-light/Cmd-W close does not quit and status-menu/Dock Open restores the window; no new custom chrome |
| 1A — Local contract, capability, and commands | `apps/local/contracts/**` (new), `apps/local/server.js`, safe projection adapter in `src/local-companion-data.js`, local fixtures/tests | Immediately; creates the reviewed interface used by every other lane | Schema and exact-key rejection; normal/no-Codex/stale/partial/unknown/failed fixtures; native capability positive/negative tests; command idempotency/cancellation tests; content-free field audit; v1 snapshot versus existing split-endpoint parity |
| 1B — Browser compatibility conformance | `apps/web/public/data-client.js`, the minimum browser renderer adapters/tests required to consume the canonical snapshot | Starts from 1A fixture draft; merges after 1A | Browser decodes the exact same fixture package; no browser pricing, freshness, or route inference survives; legacy page reflects a newer snapshot revision after refresh; public web does not imply access to personal local data |
| 1C — Swift core package | `apps/macos/Package.swift`, `apps/macos/Sources/Core/**`, `apps/macos/Tests/Core/**` | Starts from 1A fixture draft; merges after 1A | `swift test`; strict decode/major-version failure; ordering tuple handling; no network/process I/O in view-model tests; fixture bundle validation matches JavaScript schema |
| 1D — Refresh and menu state | New `apps/macos/Sources/Core/Refresh/**` and `MenuProjection/**` only | 1C and reviewed 1A command semantics | Fake-clock state-machine tests for launch/foreground/manual/202/409/cancel/timeout/restart/hide-wake; one-in-flight assertion; menu projection equals store semantics |
| 1E — Performance fixtures and harness | New bounded fixture/benchmark directories and benchmark scripts/tests only; no product composition files | Can start after 1A fixture shape is drafted | Max-dashboard budget test; extrema-preserving downsample determinism; release-build decode/render/interaction/share measurements; memory/obsolete-share-job regression baseline; report with hardware and fixture provenance |
| 1F — Native build and integration owner | `apps/macos/UsageMonitorApp.swift`, `apps/macos/Sources/MenuBarStatus.swift`, `apps/macos/Sources/Localization.swift`, `apps/macos/Resources/**`, `scripts/build-macos-app.js`, `package.json`, CI/test aggregation | Begins after 1C package shape is accepted; serialized integration only | Source-set parity check; `swift test` invoked by product test target; app hosts native fixture screen without WebKit primary route; compile/link/resource/min-target parity; no direct UI loopback calls outside core |
| 2A — Shell and Overview | New `apps/macos/Sources/UI/Shell/**` and `Overview/**`; feature-local tests/baselines | 1C; uses fixture-only store | `NavigationSplitView` route/toolbar/sidebar tests; normal titlebar/toolbar screenshot; empty/no-Codex/stale/unavailable/current states; VoiceOver labels and keyboard route selection |
| 2B — Allowance and How it works | New `apps/macos/Sources/UI/Allowance/**` and `Method/**` | 1C plus final 1A pricing fields | Currency/locale formatting; explicit event-time pricing provenance display; no price or confidence arithmetic in Swift; concise disclosure accessibility and overflow tests |
| 2C — Trends and share | New `apps/macos/Sources/UI/Trends/**` and `Share/**` | 1C plus final 1A chart fields | Dashboard/share same-series semantic test; axis/tick/domain tests; partial qualification styling; accessible table parity; `ImageRenderer` only on explicit share request/cache miss |
| 2D — Data & privacy and contribution review | New `apps/macos/Sources/UI/Privacy/**` and `Contribution/**` | 1A command/preview fixtures and 1C | Every lifecycle-inventory journey has a visible entry point; clear/cancel/disable/diagnostics privacy tests; no raw field appears in preview/export; destructive confirmations are accessible |
| 2E — Settings, About, and window commands | New `apps/macos/Sources/UI/Settings/**` and `About/**`; feature-local tests | 1C; hooks are connected only by 1F | Native logo/about links; automatic-update preference truth table; no empty Privacy settings page; Cmd-R/Cmd-comma/Cmd-W/sidebar behavior tests and persistence fixtures |
| 3A — Hosted community flow | New `apps/macos/Sources/Hosted/**` plus focused hosted-flow tests; no broad Worker rewrite | 1A review/submission contract and signed connected-preview configuration | Google/Apple success, cancel, timeout, popup-blocked, sign-out, relaunch, callback wake, and submit-retry states; page-local proof never crosses native DTO; activation returns focus to TiboTattle |
| 3B — Native integration and parity | Only 1F integration files plus focused cross-feature UI tests; serial owner | 1D, 2A–2E, 3A accepted | Connect new pages/store/commands; app root contains no dashboard `WKWebView` navigation bridge; all original journey inventory items are retained, intentionally removed, or deferred with product approval |
| 4A — Signed connected-preview qualification | `scripts/install-macos-preview-app.js` tests, release-test fixtures/runbook, preview configuration manifests/docs; no unreviewed app logic | 3B; signed connected-preview dependencies are ready | Guarded install/backup/restore; real service/Google/Apple/manual contribution/updater journey; update-error truth table; upgrade/relaunch/rollback rehearsal; signed receipts with hashes |
| 5A — Legacy cleanup and production qualification | Explicitly reviewed cleanup diff after preview, plus production release docs/tests | 4A passed and separate approval | No primary dashboard hash injection/WebKit/browser polling; released-bundle inventory proves intended retained WebKit assets only; signed production update/rollback/appcast/R2/Worker test matrix passes |

### Merge sequence and high-speed execution

1. Record the clean baseline and merge 0A as a separately reviewable safety
   patch. It must not grow the hybrid architecture.
2. Review and freeze 1A. This is the critical path: schema, capability
   transport, command semantics, fixtures, and browser-conformance expectations
   become the interface contract.
3. In parallel, begin 1B, 1C, and 1E from the fixture draft. Their first
   deliverable is test evidence, not a merge. Once 1A is accepted, rebase/merge
   1C then 1B and 1E.
4. Run 1D and 1F serially enough to avoid current AppKit/build conflicts. 1F
   only integrates accepted core code and never reimplements it.
5. Run 2A, 2B, 2C, 2D, and 2E in parallel once the core package and fixture
   contract are stable. Their directory ownership is disjoint; they do not edit
   composition, resource, or shared localization files.
6. Run 3A beside the feature lanes, then have 3B integrate the complete native
   surface in one reviewable change. A cross-feature navigation/action inventory
   is an explicit 3B deliverable.
7. Run 4A only from a signed connected preview. No unconfigured development
   build can substitute for it. 5A begins only after its upgrade/rollback
   receipt and user-visible preview review are accepted.

Each handoff contains: exact changed paths, API/schema version, fixtures added,
tests and benchmark command/output, visual evidence for visible changes, known
deferrals, and a merge/revert note. The integrator rejects a handoff whose test
environment or fixture provenance is not recorded.

## Test, visual, performance, and release gates

### Contract, capability, and command tests

- Validate every v1 payload against JSON Schema before response and in JavaScript
  and Swift fixture suites. Unknown keys, wrong types, oversized fields, and
  illegal state combinations fail closed with an actionable diagnostic code.
- Assert `DashboardSnapshot` excludes raw log contents, prompts, completions,
  reasoning, paths, event-level token payloads, identities, OAuth material, and
  arbitrary labels. This is a structural allowlist test, not a search for a few
  known bad strings.
- Spawn a test companion and prove native capability delivery is stdin-only:
  absent/wrong/rotated token requests fail, correct current token succeeds,
  inherited token is not present in command arguments or environment, and
  restart invalidates the old capability. Legacy browser compatibility routes
  never receive it.
- Assert snapshot ordering: delayed older response, ETag reuse, companion
  restart, and failed refresh cannot overwrite a newer store revision.
- For every command in the command table, test success, malformed request,
  missing capability, forbidden state, cancellation, timeout, retry, and a
  duplicate/idempotency path. Native controls cannot be wired before that
  command's fixture set exists.
- Prove event-time pricing provenance is rendered unchanged by browser and
  Swift fixtures. A native display must never reprice a historical event or
  silently substitute current-card values.

### State, lifecycle, and hosted-flow tests

- `DashboardRoute` has stable labels, accessibility identifiers, keyboard
  commands, deep-link mapping, and a visible page test. A selected sidebar item
  without its corresponding page rendered is a failure.
- `DashboardStore` covers loading, current, stale, unavailable, incompatible,
  resource-limited, failed-refresh, and companion-restarted states.
- `LocalRefreshCoordinator` uses a fake clock/process double to cover all cases
  in the visibility table. It asserts no more than one active start request,
  correct 202/409 handling, cancellation, 300-second terminal deadline, and no
  new automatic work while hidden/inactive/asleep.
- `MenuBarStatusController` is tested only as a projection of the store. It may
  change layout but may not change a fresh/stale/unknown semantic or launch a
  separate refresh loop.
- `HostedFlowCoordinator` covers browser popup, cancellation, timeout,
  callback completion, sign-out, service restart, app relaunch, focus return,
  and retry-safe contribution submission. The signed connected-preview run is
  the required real OAuth/Apple validation; fixtures do not claim provider
  integration works.

### Reproducible native visual and interaction QA

Snapshot tests use fixed, reviewed baselines rather than auto-accepting new
images. The first accepted baseline records the macOS/Swift/renderer versions.
Changes require a diff review. The minimum deterministic matrix is:

| Dimension | Required cases |
| --- | --- |
| Appearance | Light and dark |
| Window size | 900×650, 1180×860, and 1440×960 logical points |
| Text/accessibility | Default plus the largest app-supported text scale; focused keyboard and VoiceOver labels for each route |
| Data state | Current, stale, no-Codex, resource-limited, failed refresh, large currency, `Not estimable`, partial fit, and hosted unavailable |
| Interactions | Sidebar selection, toolbar refresh, Cmd-R, Cmd-comma, Cmd-W, close/reopen, menu click-out dismissal, Escape dismissal, update preference, share save/copy, and contribution cancel |

An actual installed-app review supplements snapshots on the minimum supported
macOS release and the current release. It verifies traffic lights, toolbar,
menu focus/dismissal, close/minimize/zoom behavior, non-web native selection,
and the absence of blank title/header duplication. Automation alone is not a
release substitute.

### Performance and resource budgets

All performance figures are measured on one recorded Apple-Silicon reference
machine in a release build. Other machines record results but do not change the
gate. The first accepted benchmark establishes a checked-in baseline; later
changes fail if median or p95 regresses more than 10% without an approved,
explained budget change.

| Measurement | Fixture and method | Initial gate |
| --- | --- | --- |
| Safe response size | Maximum v1 dashboard fixture at all documented cardinality limits | At most 1 MiB UTF-8; server returns `resource_limited` and retains prior verified snapshot if it cannot comply |
| Decode and store update | 100 warm snapshot decodes with 512 chart points/50 category rows | p95 no slower than 100 ms |
| First useful native frame | Cold fixture load to Overview with no network/process wait | p95 no slower than 300 ms |
| Chart route and accessibility table | 100 navigation/render cycles at 512 points | p95 no slower than 250 ms; no mandatory horizontal axis scroll at standard width |
| Explicit share render | 96-point series, cache miss then cache hit | p95 no slower than 750 ms on miss; cache hit uses existing keyed image; obsolete jobs are cancelled/coalesced |
| Native memory stability | 20 refresh/render/share cycles after warm-up | Retained RSS increase no more than 32 MiB |
| Companion parsing safety | Current maximum safe local-history fixture and unchanged result oracle | No semantic difference; no more than 10% regression in recorded refresh time or peak RSS |

The source-history fixture specifies its file/row/byte limits in metadata rather
than duplicating a brittle number in a UI test. It also records the accounting
oracle, so a performance optimization cannot silently change results.

### Installed preview and release qualification

- `product:macos:test` becomes a mandatory aggregate of contract tests, source
  parity, `swift test`, native snapshots, current local companion/cache/privacy
  tests, bundle/updater tests, and an installed native-root smoke.
- The signed connected preview uses only the guarded
  `scripts/install-macos-preview-app.js` installer. It records app digest,
  channel, build, schema/companion versions, appcast result, and backup path.
- The preview test script includes: fresh launch; no-Codex setup; manual and
  automatic refresh; all native routes; close/reopen; menu click-out/Escape;
  Settings and About; Google/Apple cancel/success; contribution review/submit
  error/retry; share; updater no-update/update-error/available-update states;
  upgrade/relaunch; and rollback from retained artifact.
- Production adds its distinct signed/notarized/appcast/Worker/R2/redirect/site
  validation. A preview success is not represented as production readiness.

## Rollback and compatibility policy

- `DashboardPresentationMode` remains local and presentation-only for at least
  one signed preview cycle. `native`, `legacy`, and `automatic` have a documented
  launch recovery override and an observable diagnostic state.
- Keep legacy split local endpoints and the browser-compatible renderer only
  until canonical snapshot compatibility and signed-preview evidence pass. They
  must consume the canonical data rather than derive alternative pricing or
  freshness semantics.
- Preserve existing cache formats, contribution queues, Keychain items, and
  event-time pricing registry compatibility. This migration changes
  presentation/transport, not the accounting record.
- If native cannot safely decode an allowed snapshot, show an actionable
  unavailable/incompatible error and allow the explicit preview legacy route.
  Never silently substitute a demo, a live-looking stale number, or a browser
  page as the production personal dashboard.
- Rollback restores the retained signed application through the guarded
  installer path, then validates the previous app against retained local state.
  It never deletes user data, contribution queues, Keychain entries, or an
  installed release as a recovery mechanism.

## Explicit non-goals

- Rewriting Node parsing/accounting in Swift.
- Replacing the local companion with a remote service.
- Exposing personal dashboard APIs on the public website.
- Duplicating OAuth/PKCE, encryption, identity, or contribution logic in the
  native UI.
- A wholesale repository reorganization unrelated to native delivery.
- Removing browser assets or WebKit before hosted-flow and fallback contracts
  are proven.
- Treating visual similarity to CodexBar as permission to reuse source or UI
  without an independent licensing/component review.

## Completion criteria

The migration is complete only when all are true:

- The installed application presents a real native titlebar/toolbar/sidebar and
  native pages for the personal dashboard.
- One versioned safe local snapshot is rendered by the app, menu bar, and share
  card without duplicated pricing, chart, freshness, or route semantics.
- Node remains the sole owner of raw local data, accounting, historical price
  selection, calibration, and contribution preparation.
- A current native refresh visibly updates the main app and menu bar; there is
  no competing foreground browser polling loop.
- Overview, Allowance, Trends, How it works, Settings, and About meet native
  keyboard, accessibility, light/dark, and narrow-window acceptance tests.
- Hosted contribution flows can be completed or cancelled without an unusable
  intermediate state, and failure messages are actionable.
- Browser/public surfaces remain clearly separate from the in-app local
  dashboard.
- A freshly built and installed app passes the visual/interaction journey;
  separately, the production configured, signed, notarized, appcast-enabled
  release passes its own end-to-end gates.

## Decisions required before execution

1. Approve the native-first architecture and the staged migration rather than
   another iteration on the current hybrid UI.
2. Approve a clean integration baseline/worktree strategy before subagents
   modify the current dirty checkout.
3. Decide whether the native dashboard feature flag is preview-only or becomes
   the default after Phase 2 visual parity; default recommendation: preview-only
   through Phase 3, then default with a browser fallback.
4. Confirm whether hosted contribution remains an isolated web surface for the
   first native release; default recommendation: yes, until exact callback and
   cancellation parity is proven.
5. Authorize a named signed connected-preview channel for human testing against
   the deployed service, redirects, and preview update feed; default
   recommendation: required. Do not substitute an unconfigured development app
   or silently point a preview client at a production-only identity setup.
