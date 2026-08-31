---
title: User guide
date: 2026-08-27
type: guide
status: maintained
---

# TiboTattle user guide

TiboTattle is a local-first macOS companion for understanding AI-tool usage,
cost, quota windows, and trends. Local analysis works without an account and
keeps session content on this Mac. Optional community contribution is a separate,
content-free, consented feature.

Current support is macOS 14 or later on Apple silicon. Windows and Linux are not
supported; see [platform support](./reference/platform-support.md).

## Install and first launch

Download the current stable DMG from `https://tibotattle.com` or the latest
GitHub release. For checksum and artifact checks, follow
[verify-release.md](./verify-release.md). Move TiboTattle to Applications and
launch it normally.

On first launch, the app explains which local sources it may inspect. Those are
the selected OpenAI Codex session and archived-session directories, the Codex
state database, display-name index and local configuration, and content-free account, quota, and
usage projections from the installed Codex app-server. The shipping refresh
does not read Claude or Gemini sources. TiboTattle derives usage/accounting
metadata; it does not upload prompts, responses, commands, filenames,
credentials, or raw session content.

The first index can take time on a large history. Keep the app open until the
foreground progress completes. Loading, unavailable, stale, or unattributed
states are meaningful; TiboTattle does not replace missing evidence with zero.

## Reading the dashboard

- **Overview and trends** summarize locally derived activity and quota evidence.
- **Usage and costs** use the repository’s accounting/pricing contracts. A cost
  estimate is not a provider bill.
- **Quota or allowance views** use provider-reported observations where
  available. Unknown plan, reset, or coverage stays explicit.
- **Source coverage** tells you which local inputs were available. A missing
  source is not “no usage.”

Display windows do not delete older local history. The dashboard may show a
shorter horizon while the local index retains the evidence needed for replay,
corrections, and longer-term views.

Switching and cache-drop overheads estimate the API-equivalent premium in
observed comparisons, not a proven cause or a bill. A labelled covered subtotal
includes only comparisons with usable ordering and prices. Sessions whose
request order cannot be proven, and comparisons without prices, remain excluded
and disclosed; that subtotal is not the whole-period total or a percentage of
your allowance. A subtotal with no priceable comparisons stays unavailable,
not a zero-valued placeholder.

The **Thread name** column in both recent cache-drop tables opens the associated
Codex thread. A worker row shows a parent-name link and a separate bracketed
subworker link. Hover a link for the local event time; keyboard users receive
the same time in its accessible description. If a name is missing, the link
uses a shortened thread ID. If attribution cannot be proven, it stays unlinked.
Names are looked up locally and are not included in reports, share cards,
diagnostics, or community contributions.

## Refresh, progress, and recovery

Use Refresh to request a new local analysis pass. The app keeps verified prior
figures visible while newer data is being reconciled where the evidence permits.
Do not repeatedly relaunch during first-run indexing; that can make progress
appear to restart even when source data is intact.

After source scanning, **Calculating accounting…** means the app is calculating
and preparing the updated dashboard. It replaces the file counter: a small
number of changed files does not mean all the unchanged files are being read
again. Only the terminal refresh status establishes completion.

If the dashboard stays blank or reports a schema/index error:

1. Record the exact message and app version.
2. Quit and reopen once, then allow a complete refresh.
3. Do not delete Application Support, the unified index, source histories, or
   Keychain items as a troubleshooting shortcut.
4. Follow [SUPPORT.md](../SUPPORT.md) and share only sanitized diagnostics.

If the report is visible but the Overview, Usage, Trends, and Community sidebar
has disappeared, use the narrowly scoped
[collapsed-sidebar rescue](./runbooks/sidebar-stranded-collapsed-rescue.md).
That procedure resets only the persisted window geometry for published 0.1.16
and earlier builds; it does not remove usage history, credentials, or settings.

Maintainers use the preservation-first
[unified-index recovery runbook](./runbooks/unified-index-recovery.md). Recovery
is performed against a copy before replacing durable state.

## Optional community contribution

Community participation requires sign-in and explicit consent. Before the first
upload, TiboTattle presents the derived, allowlisted contribution. Contributions
are pseudonymous and omit session content. You can pause or disconnect the Mac
and request deletion through the product controls.

Signing in, pairing a device, local indexing, successful upload, aggregate
publication, and deletion are separate states. Keep the app’s displayed state
or sanitized error if support is needed.

## Privacy, local data, and uninstall

The exact maintained inventory of local reads, local stores, Keychain use,
network destinations, hosted retention, deletion, and uninstall residue is in
[local-data-and-privacy.md](./reference/local-data-and-privacy.md). The public
privacy notice is at `https://tibotattle.com/privacy.html`.

Uninstalling the app bundle does not imply that accumulated local indexes,
preferences, logs, or Keychain items were erased. That separation prevents an
ordinary application replacement from destroying history. Use documented
product deletion/disconnect controls and the support guide for intentional
cleanup; never remove broad Application Support or Keychain locations blindly.

## Updates and help

Stable builds check the signed Sparkle feed at
`https://updates.tibotattle.com/appcast.xml`. A temporary network failure should
leave the installed app usable; it does not prove an update exists or failed to
publish. Verify the current release independently if an update looks stale.

For bugs, diagnostics, privacy questions, and security reporting, start at
[SUPPORT.md](../SUPPORT.md). Security-sensitive reports follow
[SECURITY.md](../SECURITY.md). Do not attach raw session files, databases,
credentials, account identifiers, or private screenshots to a public issue.
