---
title: Public TiboTattle first-visit experience
date: 2026-08-03
type: plan
status: implementation
---

# Outcome

Make the public TiboTattle site answer, in its first viewport:

1. TiboTattle is a local-first Mac app for understanding personal Codex
   usage.
2. The public site may show a privacy-reviewed, delayed community seven-day
   estimate only when a released aggregate carries enough matched evidence.
3. A new visitor should download the signed Mac app.

The local dashboard, local scans, sign-in, contribution preparation, and
contribution controls remain inside the Mac app. This task changes checked-in
public source only; it does not deploy, publish, alter Cloudflare/R2, access
Keychain/private keys, or replace an installed app.

## Verified facts

- `apps/web/public/community.html` and `community.js` are the checked-in public
  entry. The public builder in `scripts/build-public-release-site.js` materializes
  that entry as `index.html` and derives the copied module closure from it.
- The builder's app-only ledger withholds `app.js`, `index.html`, and
  `navigation.js`; the public source tests also reject dashboard controls and
  companion-only modules.
- The current `community-weekly-snapshot-v0.1/v0.2` reader and Worker snapshot
  builder expose delayed, immutable, clipped, rounded activity cells. They do
  not expose a matched community allowance estimate, quota coverage, uncertainty
  interval, or change-confidence field.
- The current release contract requires at least 20 independent participants
  per released activity cell, but that threshold alone does not make an
  allowance estimate defensible.
- A read-only check at 2026-08-03 20:44 EDT found `https://tibotattle.com/`
  serving the old dashboard entry (`app.js`, dashboard navigation, and local
  refresh controls), not the checked-in public entry. The same check found
  `/api/v1/stats/aggregate` returning a sealed v0.1 snapshot with
  `releaseStatus: "suppressed"`. The live state is evidence for follow-up, not
  an authorization to deploy from this worktree.
- Product references require local Codex evidence and the full dashboard to
  stay in the app; local API-price-equivalent or quota-gradient results are not
  provider-confirmed allowance values and are not public community data.

## Data-availability policy

The public page will render a named **Community seven-day allowance estimate**
only from a future, explicitly released estimate payload. The renderer must
reject the estimate unless the payload is a supported version, immutable and
delayed, privacy-released, tied to one provider/plan/model cohort, and carries
the estimate value plus the evidence fields needed to interpret it (matched
quota coverage, uncertainty, and confidence/release status). It must never
derive an estimate from activity totals, API-price totals, participant counts,
or the current local dashboard contract.

Until that contract exists and is released, the page will show a concise
**Collecting matched quota evidence** / **Estimate not published** state. A
suppressed, withdrawn, unavailable, unsupported, or activity-only snapshot
will remain visibly separate from the estimate state. Activity totals may be
shown below that state when the existing privacy contract releases them, with
their existing delay, per-cell support gate, clipping, and rounding language.

## Implementation slice

- Rework the public entry hierarchy so the app purpose and signed-download CTA
  are the dominant first-visit path, while preserving verified release metadata,
  installer validation, semantic open-app fallback, accessibility, responsive
  layout, and no-installer states.
- Add a shared community estimate status/result renderer with a closed, current
  contract default of unavailable. Keep activity snapshot rendering separate so
  it cannot be mistaken for an allowance.
- Keep the public module graph rooted at `community.js`; do not import or copy
  local dashboard, identity, contribution, or refresh modules.
- Add targeted source/render tests for first-viewport information hierarchy,
  estimate state semantics, current activity-only payloads, installer states,
  and public-versus-local release output. Use the existing release builder
  tests as the output-boundary gate.

## Validation gates

- Focused browser/public tests pass, including first-visit copy order and all
  estimate unavailable/safe states.
- Public release-site tests pass and the generated output contains no local
  dashboard modules or controls.
- Release metadata and installer validation still fail closed for incomplete
  or unsafe inputs.
- A local rendered preview is inspected at desktop and mobile-sized viewports;
  the first viewport shows the product purpose, primary download action, and
  honest community estimate status without relying on JavaScript data.
- No external deployment or installed-app claim is made. The remaining release
  prerequisite is to build the public release site with a verified signed
  installer/social image and separately reconcile the live deployment before
  publishing it.

## Visual simplification revision

User review of the first implementation found the install and open steps too
separate, the page too text-heavy, and the CSS-drawn brand mark incorrect. A
current comparison with [CodexBar](https://codexbar.app/?lang=en) on 2026-08-03
showed the useful pattern: one promise, one download action, and the product
itself in the first viewport. TiboTattle will adopt that hierarchy without
copying CodexBar's identity or broad multi-provider claims.

The revised first visit uses:

- the approved `tibotattle-icon.png` bird artwork for the brand and favicon;
- a deep-green hero with the exact headline `Understand your Codex week.`;
- one install cluster containing `Download for macOS` and the subordinate
  `Already installed? Open TiboTattle` action;
- a product preview derived from the repository's labeled demo: `$1,879 API
  equivalent`, `61% remaining`, and the real seven-day history chart, visibly
  marked as illustrative rather than personal or public community data;
- one compact community-estimate status line in the hero, three short product
  benefits, and one collapsed evidence-method section below it; and
- no public Docs or project-repository link until those destinations exist.
  The current project remote returns 404 to an unauthenticated public request,
  and repository Markdown is not a published documentation surface.

The visual targets are the generated desktop and mobile concepts under
`/Users/adamallcock/.codex/generated_images/019fca39-224d-7f91-ab58-c0c20aa1247f/`.
They are design references only; the production page keeps text, actions,
status, and app-preview framing in HTML and uses a privacy-safe screenshot of
the labeled demo chart as its only new product image.

## Public polish revision

Follow-up review found that the visual hierarchy was working, but phrases such
as `Illustrative fixture`, `current contract`, and `release state` exposed
implementation and QA language to first-time visitors. Public copy will use
product language instead: `Sample data`, `built-in demo`, and short, state-
specific explanations of why a community estimate is or is not available.
The detailed privacy disclosure may describe caps, delays, rounding, support,
and uncertainty, but it must not read like an internal schema audit.

The unavailable installer state will retain the same large `Download for
macOS` control as a configured release, marked disabled and paired with the
quiet line `Signed release coming soon.` This keeps the intended action clear
without linking to or implying an installer that has not passed the release
builder. The installed-app action remains beside it; the app-only dashboard
keeps its existing shared-renderer fallback through an explicit public-site
option.

The native app already links to `https://github.com/adamallcock` and
`https://x.com/adamallcock`. A read-only check on 2026-08-03 confirmed the
GitHub profile is public and the X profile URL resolves. The public website may
therefore use those profile links in its footer. It must not link to either
`app-usagemonitor` or `tibotattle-client` until an owner-approved public source
repository exists. There is still no public Docs destination, so no Docs link
will be invented.

The Apple, GitHub, and X marks are vendored from Simple Icons 16.21.0, whose
official repository distributes its SVG library under CC0-1.0. Bundling the
files keeps the release site self-contained; the page does not contact an icon
CDN at runtime. The approved `tibotattle-icon.png` remains the product icon,
favicon, and app-preview identity.
