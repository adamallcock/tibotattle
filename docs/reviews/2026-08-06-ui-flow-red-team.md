---
title: TiboTattle product-quality and macOS UX red-team review
date: 2026-08-06
type: review
status: native phases now exercised; P0-15 open — the shipped app does not render its dashboard
base: d243da9
---

# Verdict

**Suitable for internal dogfood: NO** (revised 2026-08-06 after native access was
granted — see P0-15: the shipped app renders almost none of its own dashboard content).
**Suitable for external beta: no.**
**Suitable for public release: no.**

Two blockers were found and both are now closed; both lived in *distribution* rather
than in the product. One P1 remains open in the product itself: the chart layer is not
localized, so the two non-English locales present a half-translated application. The
remaining findings are copy, density, and hit-target polish.

The unexercised native surfaces are recorded as unexamined, not as passed. See
[What remains](#what-remains).

# Target provenance

Establishing *which* product was reviewed, before any opinion about it.

| Layer | State |
| --- | --- |
| Source | `codex/integrate-spark-exclusion` @ `d243da9`, clean tree |
| Installed | `/Applications/TiboTattle.app`, 0.1.0 build 1009, `com.usagemonitor.local` |
| Signature | Developer ID Application: ADAM ALLCOCK (43RTH622SB), hardened runtime |
| Notarization | `spctl`: accepted, "Notarized Developer ID"; `stapler validate` passes |
| Channel | `internal-dogfood` |
| Service | `https://tibotattle.com` (shared with the public site by design) |
| Updater | `https://dogfood-updates.tibotattle.com/internal-dogfood/appcast.xml`, Sparkle-signed, dedicated Ed25519 key |
| Website | `https://tibotattle.com`, Cloudflare Worker with an `ASSETS` binding |

## The installed build is not HEAD, and it does not matter

The installed bundle predates `d243da9`. It corresponds to tag
`tibotattle-internal-dogfood-0.1.0-rc7-source-20260805` (`d2bbe639`) or earlier.

That would normally invalidate every screenshot. It does not here, because
`d2bbe639..d243da9` touches only six files, all public-website scope:

```
apps/web/public/community.html
apps/web/public/community.js
apps/web/public/localization.js
apps/web/public/styles.css
apps/web/test/community-site.test.mjs
test/public-release-site.test.js
```

Zero changes to `apps/macos/`, `apps/local/`, `src/`, or `packages/`. Comparing the
installed bundle's web assets against HEAD:

| Asset | Drift |
| --- | --- |
| `app.js` | byte-identical |
| `index.html` | 2 lines — build-time version token substitution only |
| `styles.css` | 13 lines, all `.community-site` rules the app never renders |
| `localization.js` | HEAD only *adds* website strings; nothing the dashboard uses changed |

**Conclusion: the installed app is a valid audit target for `d243da9`.** Only the
public website's newest copy requires the pending deploy.

# Findings

## Closed

### P0-1 — The public website served the private dashboard

* **Flow:** public discovery. **Persona:** first-time visitor.
* **Was:** `https://tibotattle.com/` served `<title>TiboTattle</title>` with
  `src="./app.js"` and four dashboard-only DOM markers (`share-panel`,
  `identity-google-signin`, `contribution-cta`, `blind-spot-list`). `/app.js` returned
  263,965 bytes of dashboard source; `/navigation.js` also 200.
* **Impact:** a stranger received a personal analytics dashboard with sign-in,
  contribution and diagnostics surfaces — all inert without a local companion. The
  site was not recognisable as a download page.
* **Root cause:** `build-public-release-site.js` withholds the dashboard correctly (verified
  by rebuild: 13-file output, zero dashboard markers). The deployed Worker bound
  `.release-build/worker-assets`, the *unfiltered* staging directory, bypassing the guard.
* **Now:** `/app.js` and `/navigation.js` return 404; homepage serves `community.js`;
  zero dashboard markers.
* **Acceptance test:** `curl -s https://tibotattle.com/ | grep -c 'app\.js'` returns 0
  **and** `/app.js` returns 404 **and** a nonexistent path returns 404 (not a 200 SPA
  fallback, which would mask a cosmetic de-link).
* **Regression surface:** the fix lives in a deploy-time asset binding. The most likely
  silent reversion is a future deploy repointing at the staging directory.

### P1-2 — An operations console was publicly served

* **Was:** `/admin`, `/admin.js`, `/admin-client.js`, `/admin.css` all returned 200.
* **Mitigating, and correct:** `/api/v1/admin/overview` returned `ADMIN_NOT_CONFIGURED`
  with and without a forged bearer token — `ADMIN_IDENTITY_LINK_KEY` is deliberately
  unset. The console failed closed. This is good design and should be preserved.
* **Residual risk at the time:** it disclosed operational vocabulary, and would have
  become live the moment that key was set.
* **Now:** all four paths return 404.
* **Recommendation:** keep admin on a separate hostname behind Cloudflare Access rather
  than as a path on the product site.

## Open

### P1-11 — Charts are not localized; only the shell is

* **Severity:** P1, major release risk for the two non-English locales.
* **Flow:** any locale switch. **Persona:** a Chinese or Spanish speaker.
* **Repro:** open the dashboard, set Language to 简体中文 (or Español), visit
  `#weekly` and `#timeline`.
* **Expected:** the product presents in the selected language.
* **Actual:** the shell translates correctly, but every string *inside* the SVG charts
  stays English — axis labels (`<text>`), hover tooltips (`<title>`), and chart
  descriptions (`<desc>`). Observed in 简体中文 mode:
  * axis label — "7-day allowance ($)"
  * tooltip — "Quota bracket not recorded"
  * description — "Local API-price-equivalent usage with provider-observed seven-day
    allowance remaining. Times are shown in East…"
* **Scale:** 220 distinct untranslated English words survive in 简体中文 mode, including
  the core product vocabulary — usage, allowance, remaining, observed, measured, median,
  range, observation.
* **User impact:** the charts are this product's primary deliverable. A user who selects
  a non-English locale gets a half-translated application in which the most important
  surface is unreadable as intended. The `<desc>` case also means screen-reader users in
  those locales hear English descriptions inside an otherwise-localized page.
* **Smallest remediation:** route the chart rendering layer's label, title and
  description strings through the same localization lookup the shell already uses. The
  catalogue exists; the chart layer simply does not consult it.
* **Acceptance test:** in 简体中文, no SVG `<text>`, `<title>` or `<desc>` node in
  `#weekly` or `#timeline` matches `/[A-Za-z]{4,}/` other than approved technical tokens
  (API, GPT, USD, TiboTattle, Codex).
* **Likely regression surface:** any new chart series, axis or tooltip added later will
  reintroduce this unless the lookup is enforced at the rendering helper rather than at
  each call site.

### What passed in the same pass

Locale switching itself is sound and should not be reworked:

* Round-tripping English → 简体中文 → Español → English restores the original character
  profile exactly (4,453 latin / 0 han / 0 accented, identical to the starting state).
  **No stale strings survive a switch** — the specific failure the brief asks about does
  not occur.
* `document.documentElement.lang` updates correctly per locale (`en-US`, `zh-Hans`,
  `es`), which matters for screen-reader pronunciation and text rendering.
* Headings translate idiomatically rather than mechanically.

## Open (P2)

None blocks a beta on its own; together they are the gap between good and excellent.

| ID | Flow | Finding | Smallest fix |
| --- | --- | --- | --- |
| P2-3 | Trends | Two visually identical period selectors that silently desync | Render each control's existing `aria-label` visibly |
| P2-4 | Overview | 1,859px in an 860px viewport (~2.2 screens) plus a 309px setup card | Density decision; consider deferring lower cards |
| P2-5 | Chrome | `release-notes-url`, `security-url`, `support-url` all resolve to `docs.html` | Distinct destinations, or one honest label |
| P2-6 | How it works | Info controls measure 18×18px | Pad to ≥24×24, keep the 18px glyph |
| P2-7 | How it works | "Replay-safe usage grouped by recognized model" — implementation vocabulary | "Usage by model"; rename "Usage changes" |
| P2-8 | Community / setup | Browser vocabulary in a non-browser app | See below |
| P2-9 | Share | Card renders a line labelled `Debug:` | Drop the word; keep the provenance |
| P2-10 | Share | "100% … the remainder is omitted" contradicts itself | Suppress the clause at 100% |

### P2-3 — Twin period selectors desync silently

* **Repro:** open `#timeline`; click `24h` in the upper segmented control.
* **Expected:** it is clear which chart changed.
* **Actual:** the usage chart moves to 24h while the calibration chart stays at 7d.
  Both render as identical `segmented-control` pill rows; the first has no visible
  heading (`nearestHeading: null`).
* **Note:** accessible names are correct and distinct — `"Usage chart date range"` and
  `"Calibration date range"`. This is an inversion: VoiceOver users are better served
  than sighted users.
* **Impact:** two charts on screen over different windows, the second being a
  calibration *of the first*. Real misreading risk.
* **Acceptance:** each control has a visible label naming its chart.

### P2-6 — Info controls below the WCAG minimum

* **Measured:** all three `button[aria-expanded]` in `#accounting` render 18×18 CSS px.
* **Standard:** WCAG 2.2 SC 2.5.8 (Target Size, Minimum) requires 24×24 for pointer
  targets.
* **Impact:** these controls explain the product's most contested numbers, so they are
  exactly the ones a sceptical user most needs to hit.
* **Also:** none declare `aria-controls`, so the relationship to the panel they open is
  not programmatically exposed.

### P2-8 — Browser vocabulary survives the move in-app

| Location | Copy | When seen |
| --- | --- | --- |
| `#community` | "**This browser** already has a contribution session. Signing out ends it." | Every signed-in contributor |
| `#companion-setup` | "You may close **this hosted browser tab** at any time." | Companion unreachable mid-session |

A full text sweep of the dashboard found exactly two hits, so this is not systemic
drift — two stragglers from the WKWebView move. The first matters more: every hosted
contributor reaches it. Several existing tests pin the second string's wording.

### P2-10 — Self-contradicting coverage claim

The share card renders:

> "100% of recorded usage changes have a reviewed public price; the remainder is
> omitted from the estimate."

If coverage is 100% there is no remainder. The sentence is templated and does not
collapse its second clause at the boundary. On an artefact built to persuade sceptics,
a self-contradicting sentence is disproportionately costly.

# Passes worth protecting (do not change)

These were tested adversarially and held. Changing them would be a regression.

* **Chart control matrix.** With period `7d`, `Week` granularity is disabled; switching
  to `24h` additionally disables `Day`; the caption updates to "by hour · latest 1 day".
  Impossible period/granularity pairings cannot be selected. Better than most shipping
  analytics products.
* **Navigation.** Each sidebar item shows exactly one section; `weekly`, `timeline`,
  `accounting` and `community` are genuinely hidden at height 0. Overview does **not**
  contain every page in one scroll.
* **Sign-in cannot get stuck.** A "Cancel sign-in" control exists; the polling copy
  states "You can cancel this sign-in here at any time"; the timeout reads "Nothing was
  stored. Press Sign in with Google again to start a fresh sign-in." The abandonment
  case was specifically probed and is handled.
* **Share card accessibility.** The canvas carries `role="img"` and a complete
  `aria-label` covering the figures, the chart's axes and range, the date span, the
  coverage claim and the provenance. A model text alternative.
* **Share card privacy.** Swept for absolute paths, home directories, emails, external
  URLs, UUIDs and folder vocabulary. Clean — aggregates only.
* **Time zone is stated** on the timeline ("Times shown in Eastern Time").
* **Empty states name an action, not an error:** "No real usage timeline loaded.
  Analyze local usage to build recent content-free usage buckets."
* **Unpopulated links fail safe** — install-CTA anchors render `href="" hidden` rather
  than as dead links.
* **Download availability is unambiguous** — "Public download coming soon" plus "We
  will make the signed Mac installer available here when it is ready."
* **Updater channel isolation.** Separate host, bucket, object prefix *and* Ed25519 key;
  `internal-dogfood` cannot inherit stable identifiers. Do not refactor.
* **Admin fails closed.**
* **Narrow-window behaviour is correct, and correctly implemented.** Tested at 700px and
  420px across Overview, Allowance, Trends and How it works: the page never scrolls
  horizontally at any width. Two data tables do exceed the viewport at 420px (524px and
  633px), but each is wrapped in its own `overflow-x: auto` container, so the wide
  content scrolls inside itself while the body does not. That is the correct pattern
  rather than a workaround. The sidebar collapses to a stacked full-width layout.
* **Demo mode is conspicuously labelled** — see P2-12.

# Corrections made during this review

Recorded because a red-team report is worth only what its false-positive discipline is
worth. Five preliminary conclusions were discarded before they became findings:

1. **"Four dead navigation links."** The install-CTA anchors are `hidden`, not dead, and
   are not rendered in the app at all.
2. **"Trends renders no charts."** A selector artefact — the SVGs carry no `id`. Three
   charts render with geometry.
3. **"Info buttons are unlabelled."** They carry correct, distinct `aria-label`s.
4. **"The share card lost its text alternative."** The separate readout was replaced by
   `role="img"` plus a comprehensive `aria-label` — a better pattern.
5. **A bug in the reviewer's own monitor.** `grep -c … || echo "?"` appended a fallback
   *alongside* a legitimate `0`, because `grep -c` exits non-zero on zero matches. The
   website fix went undetected until a heartbeat printed the raw values.
6. **"The allowance span slider is unlabelled."** It carries both a `<label for>` and a
   wrapping `<label>`, yielding "Minimum observed quota span … 50+ pp". The initial check
   read only `aria-label` and missed the native association, which is the preferred
   pattern.

# Phase E — Overview and allowance

Exercised and substantially clean.

* The seven-day estimate leads with a plain-language heading, "Our best estimate of the
  seven-day limit", and states its uncertainty as an "80% across-reset range"
  ($1,393–$2,194 over 17 qualifying reset estimates) rather than a bare point value.
* The minimum-span filter works and **discloses itself**: "The chart currently shows
  observations spanning at least 50 percentage points."
* Controls are correctly named: the period group is `"Weekly history date range"`; the
  slider resolves through native `<label>` association.

One nit, standards-grounded: the span slider has no `aria-valuetext`, so a screen reader
announces "50" without units. WAI-ARIA recommends `aria-valuetext` where the raw number
is ambiguous — here it should read "50 percentage points". Same class as P2-6; fold into
that fix. The slider is also 150×16px, so its thumb is under the 24px minimum, though
the 150px track gives generous horizontal room.

## Untested, and it matters on this branch

The brief asks whether **secondary, Spark, monthly and unknown-plan** allowance tracks are
separated correctly. **This could not be assessed.** The reviewing account's data contains
only a seven-day track; none of those vocabularies appear anywhere in the rendered
allowance surface.

That is a coverage gap rather than a finding — absence of evidence is not a defect. But
this branch is named `codex/integrate-spark-exclusion`, so Spark handling is the freshest
code in the tree and is exactly what a red-team pass should be exercising.

### P2-12 — The labelled demo fixture cannot exercise Spark, monthly, or unknown-plan

The obvious way to close the gap above is the product's own labelled demo. It does not
close it. Entering demo mode (`#demo-button`) renders only the **7-day** and **5-hour**
tracks. Spark, monthly and unknown-plan are absent, while the source carries
`CODEX_SPARK_LIMIT_ID` as a first-class concept and 7 further `spark` references.

The consequence is stronger than a reviewer's missing data: **no one can observe Spark
handling anywhere in the product without possessing a real Spark allowance.** On a branch
named for Spark exclusion, the behaviour being changed has no reachable demonstration —
not for a reviewer, not for a new user exploring the demo, and not for a support
conversation.

* **Smallest remediation:** extend the demo payload with a Spark track, a monthly track
  and an unknown-plan cohort, so the separation logic renders somewhere observable.
* **Acceptance test:** in demo mode, each supported allowance track appears exactly once
  and is labelled distinctly; no track is merged into another.
* **Value:** this is the cheapest way to make the branch's own subject testable, and it
  converts an untestable claim into a demonstrable one.

Until either that fixture exists or an account carrying those tracks is available, the
correctness of Spark exclusion and of multi-track separation is **unverified by this
review**.

### What passed alongside it

Demo mode is unmistakably labelled and should not be softened: "Illustrative fixture —
not your usage", "You are exploring a labeled demonstration", "Every number on this page
is illustrative." The brief asks whether placeholders are ever presented as functional;
here the product goes conspicuously out of its way to prevent that reading.

# What remains

## Blocked on tooling

The automation layer does not list `/Applications/TiboTattle.app`, so these could not be
exercised:

* menu bar: icon legibility, dismissal, keyboard navigation, state transitions
* Settings: information architecture, persistence across relaunch, permission flows,
  whether the refresh interval changes real scheduling
* installation and first launch, Gatekeeper behaviour
* native window: title bar, resizing, focus, `Escape` / `Cmd-W`
* VoiceOver ordering, reduced motion, contrast in both appearances
* the direct CodexBar comparison

## Blocked on state

* update flows — need a feed advertising a newer version than 1009
* contribution submit / reject / retry — would write to production
* locale switching beyond static inspection

## CodexBar baseline (established, comparison pending)

| Axis | CodexBar |
| --- | --- |
| Shape | Menu-bar-only, no Dock icon, macOS 14+ |
| Menu-bar item | The icon *is* a usage meter; dims or shows an incident overlay when stale |
| Surface | Popover: provider tiles, usage bars, reset countdowns, inline charts |
| Settings | Three tabs — Providers / Usage & Spend / Advanced |
| Refresh | Adaptive default; manual 1m/2m/5m/15m/30m |
| Localization | 21 languages with RTL |

TiboTattle is a Dock app whose primary surface is web content in a native shell, and its
source is explicit that this is deliberate: the menu bar "never becomes the only place
the app lives". That is a legitimate product difference and is **not** filed as a defect.
It does mean TiboTattle carries a burden CodexBar does not — making a WKWebView *feel*
native — and it ships 3 locales against CodexBar's 21.

## Structural comparison — SOURCE-DERIVED, interaction quality NOT assessed

The following is read from `apps/macos/Sources/MenuBarStatus.swift`. It establishes what
the menu *contains*; it says nothing about how the surface feels, how it dismisses, how
the icon reads against a busy menu bar, or whether the percentage is legible at a glance.
**Those require the runtime access this review did not have, and must not be inferred
from this table.**

| Axis | CodexBar | TiboTattle (source) |
| --- | --- | --- |
| App shape | Menu-bar-only, no Dock icon | Dock app; menu bar deliberately additive |
| Surface type | Popover | `NSMenu` |
| Contents | Provider tiles, usage bars, reset countdowns, inline charts | Two disabled information rows, then Open, Analyze, Check for Updates, Settings, About, Quit |
| At-a-glance density | High — per-provider meters and charts | Low — two lines of text |
| Shortcuts | not established | ⌘R analyze, ⌘, settings, ⌘Q quit |
| Localization | 21 locales, RTL | 3 locales; **the menu is localized** |

Two observations follow from the structure alone:

1. **The keyboard shortcuts are correct macOS convention** — ⌘, for settings in
   particular is the platform-standard Preferences binding, and ⌘R/⌘Q are conventional.
   This is a pass on standard terminology and controls.
2. **The menu-bar surface offers materially less at a glance than the benchmark.**
   CodexBar's popover *is* the product; TiboTattle's menu is a status line plus a
   launcher. Given TiboTattle's window-centric architecture this is defensible, but if
   the goal is parity with CodexBar as a glanceable monitor, two text rows against
   per-provider bars and countdowns is the gap to close. Recorded as a **product
   decision to make deliberately**, not as a defect.

A third observation reinforces P1-11 rather than the comparison: the native menu carries
a full set of localization keys (`menuBarAllowanceTitle`, `menuBarFiveHourAllowance`,
`menuBarLocalEvidenceStale`, and others). So the localization discipline exists and is
applied in the native layer — it is specifically the web chart layer that does not
consult the catalogue. That makes P1-11 an isolated omission rather than an absent
capability, and correspondingly cheaper to fix.

# Smallest set of changes to reach "suitable for external beta"

1. Resolve native-surface access so the menu bar, Settings and first-launch flows can be
   exercised. This is the only true blocker; the rest is polish.
2. Fix P1-11 — route chart labels, tooltips and descriptions through the existing
   localization catalogue. Without it, the shipped 简体中文 and Español locales present
   English charts.
3. Fix P2-8 (`#community` browser copy) — every hosted contributor sees it.
4. Fix P2-9 and P2-10 — both ship on every publicly posted share card.
5. Fix P2-6 — a measurable accessibility standard, not a preference.
6. Add a deploy-time assertion that the published site bundle contains no `app.js`,
   `navigation.js`, or `admin.*`, so P0-1 cannot silently return.

Item 1 is the gate on completing the review. Item 2 is the gate on honestly claiming
three-locale support. Items 3–6 are hours of work.

---

# Live public website — full audit (post-fix, 2026-08-06)

The public site was re-deployed by another agent (`a5879ea`, `5c6f29f`). P0-1 and P1-2
were re-verified as closed, then the live site was audited exhaustively: 8 adversarial
dimensions, 65 agents, every finding attacked by an independent verifier instructed to
refute it. 43 findings survived, 12 were refuted. **The two P1s below were then
re-verified personally**, because a relayed finding is not an established one.

## P1-13 — The site is served in full over plaintext HTTP

**Verified personally.** `http://tibotattle.com/` returns **200 with zero redirects**, and
the plaintext body is **byte-identical** to the HTTPS body (SHA-256 `44bae2f933c3d34c…`).
No HSTS. No CSP, X-Content-Type-Options, Referrer-Policy or Permissions-Policy on any
route.

```
curl -s -L --max-redirs 3 -o /dev/null -w '%{http_code} redirects=%{num_redirects}\n' http://tibotattle.com/
# 200 redirects=0
```

* **Impact:** the sharper edge is not data exposure — nothing confidential transits the
  site yet (no login, no forms, no cookies, download not live). It is that **executable
  JavaScript is served over plaintext**, so anyone on a hostile network can modify
  `community.js` in flight. For a product whose entire differentiator is privacy, this is
  also the first thing a technical reviewer will check.
* **Fix:** two Cloudflare toggles — Always Use HTTPS, and HSTS. No code change.
* **Acceptance:** `curl -I http://tibotattle.com/` returns 301/308 to `https://`, and the
  HTTPS response carries `Strict-Transport-Security`.

## P1-14 — Focus indicator fails contrast against the dark hero

**Verified personally, and the reported diagnosis was wrong.** The audit reported a
"42%-alpha outline failing sitewide at 1.35:1". Measured: `--blue` is `#315f84` at
**alpha 1.0**, giving **2.14:1 against the hero** and **5.96:1 against the body**.

* The failure is **real but narrow**: it fails WCAG 2.2 SC 1.4.11 (3:1 for UI components)
  only against the dark hero region, and passes comfortably elsewhere. It is not sitewide
  and not an alpha problem.
* **Fix:** a hero-scoped focus colour with ≥3:1 against `rgb(8,47,42)`.
* **Note:** this also refines an earlier conclusion in this review. The focus-ring
  *coverage* audit (universal `a/button/input/select/summary:focus-visible`, every
  `outline:none` paired with a replacement) was correct and remains a pass. Coverage was
  verified; **contrast was not**, and calling it "comprehensive" overstated it.

## Verified P2s worth acting on

| ID | Finding | Verified |
| --- | --- | --- |
| L10N-1 | `docs.html` and `privacy.html` are permanently English-only | 0 script tags and 0 language markup vs 1 and 17 on the homepage |
| MD-3 | `/favicon.ico` 404s **with 13,247 bytes of HTML** | confirmed — SPA fallback serving HTML for a missing icon |
| EDGE-3 / MD-7 | `/404` returns **200**; `/community` returns **200** with a homepage copy | confirmed |
| C3 | UTC-sealed snapshot period rendered in viewer-local time — mislabels the week for every UTC-negative viewer | from source; not independently reproduced |
| RL-1/2/3 | Horizontal scroll at 320px; footer collision in Spanish at ≤367px, including **360px**, the most common mobile width | from CSS analysis; not independently reproduced |
| FVC-2 | "API equivalent" is the page's dominant number and is defined nowhere on the site | consistent with the rendered copy |
| C4 | The HTTP-error branch prints a raw machine code and a bare UUID, and the site offers no support channel to quote them to | from source |

The remaining ~30 P2s are recorded in the workflow transcript. They are genuine but
individually minor; treating this table as the actionable set is the right call.

## Corrections applied to the audit's own output

Twelve findings were refuted by the verification stage before reaching this document. Two
more were corrected here: the focus-contrast diagnosis (wrong cause, wrong numbers, wrong
scope) and the severity of the transport defect (P0 → P1, since nothing confidential
transits the site yet). A relayed finding was treated as a hypothesis until reproduced.

## Website verdict

**Not launch-ready today, blocked by one thing.** The copy, honesty and structure are
sound — the download is truthfully gated, the hero preview is labelled "Example only —
not your usage or a bill", the community empty state discloses absence without leaking
its internal reason code, and the accessibility posture is better than the in-app
dashboard (13 focusables, zero unnamed, zero targets under 24×24, a working skip link).
What disqualifies it is the transport layer, and that is two toggles. Fix P1-13 and
P1-14 and the site is fit to ship.

---

# Native app audit (access granted 2026-08-06)

Automation access was granted at full tier, unblocking the native phases.

## P0-15 — The app's dashboard renders almost none of its own content

**This is the most serious finding in the review, and it is in the app, not distribution.**

* **Persona:** every user, every launch. **Flow:** open TiboTattle; click any sidebar item.
* **Expected:** the app shows the allowance, as the same page does in a browser.
* **Actual:** the window renders a page hero, a "Latest observation" card and the footer.
  Roughly 60% of the window is blank. **Overview shows no allowance number at all**, and
  **Allowance renders nothing but the footer**. The native sidebar highlight moves
  correctly when clicked, but the content does not follow.

**Controlled comparison — same companion instance, same moment, same 890x730 viewport:**

| Section | Browser at `127.0.0.1:61435` | App web view |
| --- | --- | --- |
| `#setup-card` | 309px, visible | absent |
| `#overview` | **2,151px, visible, 299 words** | hero + footer only |
| Allowance cards | "Seven-day allowance · provider-reported plan: pro · **55% remaining** · 45% used · resets 5d 15h" | not shown |
| Spark track | "**Spark allowance · separate limit · 100% remaining**" | not shown |
| `#weekly` | 983px, 568 words, 1 chart | footer only |

The menu bar simultaneously reports "TiboTattle · 55% allowance", so the **data exists and
the app knows it** — it simply never reaches the window.

**Ruled out by test, not assumption:**
* Not a window-width issue — the browser was set to the app's exact content width.
* Not a data or companion issue — same companion process, same second.
* Not a stale first render — a full quit and relaunch onto a fresh companion (port 61435)
  and a fresh web view reproduced it identically.
* Not `.nonPersistent()` web storage — `localStorage` holds only a 5-byte language
  preference and `app.js` uses no web storage for rendering.
* Not the injected JavaScript — the only injection forces `#overview` and scrolls to the
  share panel, and runs on the Share toolbar action, not on load.

**Impact:** the app is the product. A user who installs TiboTattle, opens it, and clicks
Allowance sees an empty page. Everything this review praised about the charts, the
uncertainty presentation, the honest empty states and the density decisions is
**invisible to a user of the shipped application** — it is reachable only by opening the
loopback URL in a separate browser, which the product deliberately moved away from.

**Smallest remediation:** unknown without engineering investigation; the section-reveal
path between the native sidebar and the page is the place to start, since the highlight
moves while the content does not.

**Acceptance test:** with the app open at any window size, each sidebar destination
renders the same section content that `http://127.0.0.1:<port>/#<hash>` renders in a
browser at the same viewport, verified by comparing rendered section height and word
count.

**Regression surface:** any future change to the native chrome's destination selection.

## Menu bar — passes

Exercised live. Better than the source-only estimate in the earlier CodexBar comparison.

* Three information rows, not two: allowance, evidence provenance ("Observed 3 minutes
  ago · verified current evidence"), and **a reset countdown** ("Seven-day allowance: 55%
  · resets in 5d 15h") — the same class of information CodexBar surfaces.
* Correct macOS form: disabled information rows in grey, actions in black, logical
  separator grouping, right-aligned shortcut glyphs, ellipses on the two items that open
  further UI, product name in About and Quit.
* Shortcuts follow convention: ⌘R update, ⌘, settings, ⌘Q quit.
* **Outside-click dismissal works.**
* The icon renders legibly as a template glyph beside the percentage.
* Cross-check: CodexBar's own menu-bar item showed **the same 55%** at the same moment.

**Could not verify — Escape dismissal.** Synthetic key events do not reach an open
`NSMenu`'s modal tracking loop; outside-click does, which is what isolates it to tooling.
The app declares an `escapeDismissalMonitorInstalled` flag in
`NativeMenuPresentationContract`. **This needs one human keypress to confirm** and must
not be recorded as either a pass or a defect until then.

## Native shell — observations

* The window is a genuine native shell: real title bar, traffic lights, native sidebar
  with SF Symbols, and an `NSToolbar` carrying Refresh / Share / Settings.
* The toolbar's freshness state reads "Fresh" and matches the menu bar.
* Refresh moves focus to the page `h1` — correct practice for announcing a content
  change to assistive technology.
* **P2-16 — the app has only two menus, `TiboTattle` and `Edit`.** There is no `Window`
  menu and no `Help` menu. macOS convention expects both; `Window` in particular provides
  minimize/zoom/bring-all-to-front, and its absence is noticeable in a windowed app.
* **P2-17 — the documented diagnostics log does not exist.** Dashboard copy tells users
  failures are appended to
  `~/Library/Application Support/app-usagemonitor/diagnostics-v0.1.log` "so you can quote
  it when asking for help". That file is not present. It may be created lazily on first
  failure — worth confirming, because if it is not, the documented support path is broken
  at the moment a user needs it.

## Verdict change

**Internal dogfood: no longer yes.** P0-15 means the shipped application does not show
its own primary content. That is not a dogfood-tolerable defect; it is the product not
working. The earlier verdict was reached without native access and is superseded.
