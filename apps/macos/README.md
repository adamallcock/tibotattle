# Native macOS app

This directory contains TiboTattle's supported native foreground launcher and
macOS release contracts. Public stable releases are signed, notarized, packaged,
and published through the retained external-distribution gates. A local source
or development build is usable for development but does not inherit those
release claims. The canonical operator sequence is the
[macOS stable release runbook](../../docs/runbooks/macos-stable-release-runbook.md);
this README documents the maintained component and user lifecycle.

For the native/loopback launch contract, fixed URL scheme, WKWebView messages,
Keychain broker, Codex subprocess protocol, platform APIs, and system diagram,
see the canonical
[TiboTattle API surface reference](../../docs/reference/api-surface.md).

The packaged companion reaches Keychain only through the app's private
protocol-v2 socket broker. Its closed capability enum covers export identity,
account observation, Claude-session pseudonym, and contribution device; no
service/account string crosses the wire. The current packaged-companion graph
uses the export-identity, account-observation, and contribution-device
mappings; the Claude callback remains a standalone CLI/local-review
composition. When only a legacy `.v1` item exists, a narrow native helper with
the legacy Node signing identity attempts a silent read up to three times, with
short backoff. Automatic reads forbid Keychain interaction. The retry budget is
shared for the app process, including companion restarts. The helper can serve
only an authenticated native parent over its private descriptor; it accepts no
service, account, path, or arbitrary credential query.

The native app creates the `.app.v1` item only if absent and verifies an exact
readback. A conflicting modern item is never overwritten; the legacy item is
retained as a recovery copy. If silent attempts cannot finish, the broker
returns `migration_required` and the app quietly offers **Settings… → General →
Secure upgrade → Review migration…**. Only the explained **Approve migration**
action can enable a Keychain prompt. Cancel is the default, and a denial leaves
the key intact and does not schedule another prompt. The menu's **Finish secure
upgrade…** action opens Settings, not the system prompt. Reset or deletion is
not migration recovery. All four adapters retain a content-free
migration-required diagnostic. The packaged runtime excludes `@github/keytar`;
standalone CLI/local-review tooling retains that compatibility backend. See the
[migration decision and remaining qualification gates](../../docs/decisions/2026-08-31-silent-keychain-migration.md)
before treating source tests as signed-upgrade evidence.

## Consumer lifecycle in the app

The companion's first snapshot uses its bounded startup projection and retains
only validated last-good evidence with explicit coverage labels. The initial
automatic refresh updates current quota/headline evidence only. Manual
**Refresh** updates quota and detailed accounting together; detailed accounting
also runs through the bounded hourly attempt;
optional contribution requests do not define local-dashboard readiness.
The native host treats 20 seconds as a quiet slow-load threshold, keeps the
document visible, and continues one generation-fenced readiness observation for
at most 120 seconds. A stalled JavaScript reply cannot suspend that deadline.
New navigation or teardown cancels the old observation. A valid late result (or
an explicit Open Dashboard after the hard deadline) consumes the pending initial
refresh once and clears the stale readiness-timeout diagnostic.

1. Launch **TiboTattle.app**.
2. On the first launch, review the one-time **Get Started** disclosure. It
   names every normal local source: selected Codex `sessions` and
   `archived_sessions`, `state_5.sqlite`, `session_index.jsonl`, `config.toml`, the installed Codex
   app-server methods `account/read`, `account/rateLimits/read`, and
   `account/usage/read`. It also explains what owner-only derived state is
   retained, which content is excluded, how optional contribution stays off,
   and what happens when the window or app closes. The
   accessible native **Start TiboTattle at login** control is
   visibly preselected. Choosing **Get Started** is the affirmative action
   that may register the native Login Item; clearing it continues without a
   Login Item. The acknowledgement is an owner-only local receipt; moving
   local app data to Trash makes the disclosure appear again.
3. The native window starts one private loopback companion on an ephemeral
   port and performs a quick quota/headline refresh while the normal app
   remains open. The Login Item adds no separate scanner; raw logs and prompts
   are never uploaded by the launch itself, and optional contribution keeps its
   separate review and consent controls.
4. A menu-bar status item appears alongside the window and the Dock icon. It is
   an additional affordance, not a replacement: the app stays a regular
   foreground application and installs no `LSUIElement` agent. The compact
   title shows the primary observed quota lane only while the companion reports
   fresh verified evidence; stale, unobserved, starting, and failed states all
   show a neutral `–`. An in-progress pass keeps the fresh current number when
   one is available and shows `…` only while no current lane can be shown.
   Left-click opens a
   transient native popover with fresh-only five-hour and seven-day allowance
   tracks, the shared weekly pace forecast expressed as under, near, or over
   sustainable pace with a now-to-reset coverage track, and coverage-aware
   local-calendar usage bars for 7 or 30 days. The pace reading is shown only
   after compatible local quota observations bind to the exact current weekly
   reset; one observation is named as collecting, never promoted to a trend.
   The bars use
   observed tokens; dollar figures are explicitly Standard API-price
   equivalents, not a subscription bill, and disappear when pricing evidence
   cannot support them. During refresh the last completed usage analysis stays
   visible with an explicit retained-history label, including both chart ranges
   and their original coverage. A transient read failure also keeps that
   labelled history, while current quota and forecast claims are cleared.
   Companion restart or source replacement clears all previous in-memory
   evidence; first-run or invalid history is never fabricated. Missing evidence
   is a named gap, never a zero. The
   popover forecast is an ephemeral, strict projection from the companion's
   narrow read-only weekly-pace endpoint. Request-time geometry is recalculated
   from the retained strict forecast without rerunning accounting; it is never
   stored, logged, exported, or added to community data. It contains no account
   identity, plan claim, purchase flow, reset credits, or redemption action.
   Clicking outside the popover dismisses it even if another app was already
   active when it opened. Its outside mouse listener exists only while the
   popover is open; it does not record event content, monitor global keys, or
   consume clicks destined for other apps. Popover controls and a second click
   on its status icon retain their normal control and toggle behavior.
   Right-click or Control-click opens the native action menu with **Open
   TiboTattle**, state-aware **Analyze/Update Local
   Usage**, Settings, About, update checks when available, and **Quit
   TiboTattle**. Quit uses the same graceful shutdown as the window's own Quit
   control.
5. Choose **Open TiboTattle** and explicitly start local analysis.
6. If the companion fails or exits, choose **Retry**. The app does not require
   a relaunch for ordinary recovery.
7. Choose **Data & Diagnostics…** to see and copy a fixed, path-free diagnostic
   receipt. Startup and lifecycle failures include a stable `UM_MACOS_*` code
   and a fixed recovery action.
8. Choose **Codex Source…** to select a custom `CODEX_HOME` with the native
   folder picker, or restore `~/.codex`. The selection is revalidated at every
   launch and stored only in the owner-only app state; copied diagnostics expose
   only `default` or `custom`, never the path.
9. Choose **About TiboTattle** → **Check for Updates** to check a signed
   production appcast. Automatic update downloads are controlled by one native
   switch in **Settings…** → **About**. Developer and ad-hoc builds contain
   no updater framework and perform no update networking.
10. **Settings…** → **Notifications** contains **Local allowance
   notifications**. It is off by default; enabling it is the only action that
   may request macOS notification permission. The first opt-in visibly selects
   80% and 90% usage alerts. Reset alerts use the provider-reported reset time
   and notify once when the next foreground refresh arrives at or after that
   time. A provider-reported reset identity strengthens dedupe when available;
   a schedule change before the old due time replaces the baseline without
   alerting. TiboTattle evaluates threshold and reset alerts only after the
   existing foreground refresh receives a fresh direct
   `account/rateLimits/read` observation. Stale, inferred, mixed-source,
   unobserved, unknown, forecast, time-only, and log-derived state never
   alerts. Turn the same switch off to immediately stop future alerts and
   clear only their local notification baseline, pending-request, and dedupe
   state; it does not erase accounting evidence. This feature adds no daemon,
   login item, timer, network polling, push service, or account identity that
   leaves this Mac.
11. A trusted website or browser bookmark may use `usagemonitor://open` to
   activate the app and open its loopback dashboard. All other hosts, paths,
   credentials, queries, and fragments in that custom scheme are rejected.
12. Closing the primary window leaves the regular menu-bar app available;
   **Quit TiboTattle** stops the companion. If the person accepted the
   first-run default or later enables it in Settings, the app uses one native
   Login Item to launch this normal app at login. It never installs a daemon,
   LaunchAgent, privileged helper, or separately persistent worker. After an
   explicit reviewed first contribution, the user may enable six-hour
   contribution while the app remains open.

Keep the app open while local analysis runs. Closing the TiboTattle window
hides that window; the menu-bar item can reopen it. Explicit Quit stops the
current pass; completed checkpoints remain available on the next launch.
**Open in Browser** is a separate optional control in the app, not the primary
dashboard destination.

### Launch-at-login lifecycle

TiboTattle supports macOS 14 or later and uses Apple's
`ServiceManagement` `SMAppService.mainApp` API directly. A fresh install does
not register during launch or status refresh: the first-run checkbox is only a
preselected choice. On first run, its **Get Started** action is the sole point
that may request registration. Existing installs that completed the earlier
first-run receipt are never registered by an update; they can opt in from
**Settings…** → **General**.

The Settings control reads the service's reported state rather than treating a
stored preference as proof. It refreshes when Settings opens, when the app
becomes active again after System Settings, after an explicit **Refresh Login
Item Status** action, and after every requested change. A non-throwing request
is not treated as proof: TiboTattle reads the status again and says whether
enable/disable was confirmed, needs approval, was not confirmed, or is
unavailable. If approval is pending, the toggle is disabled rather than shown
as a misleading off state; **Remove Pending Login Item** can explicitly
withdraw it. The setting affects app launch at login only: it does not add a
separate scan, keep a companion process alive after Quit, send a contribution,
or permit a silent background upload. The existing bounded refresh remains a
normal-app, while-running behavior.

The ordinary regular window remains visible when the app launches. The product
does not use an undocumented heuristic to guess whether a particular startup
came from login versus a person opening the app, because that could hide a
manual launch. Closing the window is the explicit way to leave the regular
menu-bar companion running; **Quit TiboTattle** still stops it.

## Report and native-toolbar boundary

The primary in-app experience remains the rich local WebKit report: its charts,
tables, text, and existing share card are not replaced with a sparse native
dashboard. The regular AppKit window keeps the usual close, minimise, and
resize controls. Its unified toolbar adds only the native affordances that are
better outside the report: local status, **Refresh usage**, **Share**, and
**Settings**. **Share** opens the report's existing local share card; it does
not create a second report or sharing service.

Both recent cache-drop tables offer local **Thread name** links, with separate
parent and subworker links when ancestry is known. Click or keyboard-activate
a link to open its canonical `codex://threads/<UUID>` target in Codex. A
native-owned isolated content world checks the trusted click; the shell then
revalidates the source main frame, pinned companion origin, and exact target.
Programmatic navigation and generic new-window requests cannot open Codex, and
no names or identifiers are logged or persisted by this handoff. Native
context-menu **Open Link** does not perform this Codex handoff; use the link
itself. Existing HTTPS and hosted sign-in-return behavior are unchanged.

The toolbar has no independent data authority. **Refresh usage**, Cmd-R, and
menu-bar/popover Refresh use the already-running loopback companion's detailed
route: quota and retained history advance together, and valid cached accounting
is reused. There is no separate detailed-accounting action. The foreground interval may make at
most one automatic detailed attempt per hour while no refresh is in flight;
startup and intervening checks stay quick. Failed, cancelled, and interrupted
detailed attempts count toward the hourly budget. A companion terminal receipt
clears the native busy state before optional presentation reads; activation and
wake reconcile that state without launching a second refresh.
There is still one companion child while the app is open; the in-app refresh
timer is only foreground scheduling, not a daemon, login item, LaunchAgent, or
background URL session. The separate Keychain-reset helper remains available
only after its explicit diagnostic confirmation and is unrelated to the
toolbar or usage accounting.

The troubleshooting-only local erase action moves only
`~/Library/Application Support/Usage Monitor` to Trash after the companion has
stopped, and clears the app's persistent WebKit cookies, caches, and bounded
sign-in recovery state. It does not modify Codex logs, revoke already-sent
community data, or remove a pseudonymous identity stored in Keychain.

The separate **Identity & Device Reset…** diagnostic action remains available
for support cases. It has two native confirmation steps and targets exactly two
local Keychain capabilities:

- the pseudonymous export identity; and
- the paired contribution-device credential.

Before touching Keychain, it stops the companion and validates the two exact
local residue files. Other indexes, cached analysis, prepared contributions,
settings, account-observation keys, Claude-session pseudonym keys, and Codex
logs remain. The action does not revoke a hosted device or delete hosted data;
confirmed **Disconnect this Mac** separately revokes this device's hosted
authority while preserving hosted/local history. Private owner erasure is
separate and has no self-service app control under the
[2026-08-30 source contract](../../docs/decisions/2026-08-30-self-service-deletion-retirement.md).
This source change is not an installed-release or deployment claim. Local reset
does not claim secure erasure.
After the reset, future contribution activity uses a new identity and requires
pairing again.

The ordinary uninstall journey is simply: quit TiboTattle and move
**TiboTattle.app** to Trash. Advanced local cleanup is kept under
**Data & Diagnostics…** rather than presented as part of normal onboarding.

## Developer build

The builder requires Node 26.2.0 on Apple silicon. Its default target remains
Apple silicon:

```bash
npm run product:macos:build
npm run product:macos:validate:development
open ".release-build/macos/TiboTattle.app"
```

An Intel target is available on the same builder; it is not yet publicly qualified:

```bash
node scripts/build-macos-app.js --architecture x64 \
  --node-runtime "<verified-node-v26.2.0-darwin-x64>/bin/node" \
  --test-build --output ".release-build/macos-intel-test/TiboTattle.app"
```

Use the official Node 26.2.0 Darwin x64 distribution, including its adjacent
`LICENSE`. The builder checks the pinned executable and license hashes before
executing the staged runtime. It compiles the launcher and native Keychain
migration helper for `x86_64`. A development build retains ad-hoc signing and a
disabled updater. Do not install this shared-identity development app over a
stable app or run it against stable user state as a qualification shortcut.

The DMG packager, installer validator and release CLI accept `--architecture
x64`; native inspection checks all bundled executables against that target.
Release construction also requires the verified `--node-runtime`. Preview and
release modes retain their existing signing, source, identity and credential
gates. Intel uses separate stable/dogfood/Preview feeds; it cannot consume the
Apple silicon feed. No new Homebrew Intel support is claimed.

These source paths do not qualify real Intel hardware, final signed/notarized
installers or updater installation. See the
[Intel release plan](../../docs/plans/2026-09-03-macos-intel-release.md) and
[macOS release runbook](../../docs/runbooks/macos-stable-release-runbook.md)
for the remaining gates. The commands below show the default Apple silicon
packaging path; pass `--architecture x64` and the Intel app path for Intel.

Create a deterministic-layout developer DMG:

```bash
npm run product:macos:dmg
node ./scripts/validate-macos-install.js \
  --dmg ".release-build/macos/TiboTattle-0.1.0-macOS-arm64-development.dmg" \
  --development
```

The DMG command fixes its volume name, layout, HFS+ filesystem, compression
level, file ordering inputs, and timestamps. A Developer ID timestamp and
Apple's disk-image tooling make byte-for-byte identity across release machines
an invalid promise; the command records the resulting SHA-256 instead. Its
explicit `--development` mode only packages an updater-disabled development
bundle, requires a `-development.dmg` filename, and reports the artifact as
ad-hoc, non-notarized, and not update-ready.

## Localization and regionalization

TiboTattle ships English (`en-US`), Simplified Chinese (`zh-Hans`), and
Spanish (`es`) for product-owned native and browser copy. General settings has
a persisted **Language** picker; it defaults to the Mac's preferred language
and falls back safely to English. `zh-TW`, `zh-Hant`, and an ambiguous `zh`
request do not select the Simplified Chinese catalog.

Native strings live under stable `menu.*`, `settings.*`, and `notification.*`
keys. Add another locale only when its native catalog and dashboard copy are
complete together.

Native resources live in `Resources/{en,zh-Hans,es}.lproj/Localizable.strings`.
The build records them in the source digest and copies them both to the app
bundle root and to `Contents/Resources/app/localization/`. The WebKit host
injects the versioned `window.__TIBOTATTLE_LOCALIZATION__` handoff and accepts
only a closed language-preference message; a selection updates the loaded
dashboard without resetting its local/hosted sign-in state.

Before each later loopback-document load, the host refreshes its document-start
handoff so the newly loaded dashboard receives the current native choice. The
browser surface confines legacy exact-text translation to explicit product
roots and marks provider, report, identity, JSON, file, SVG, and diagnostic
values as raw. A language choice never reinterprets those values as UI copy.
The picker announces changes to assistive technology; pseudo-localization is a
test-only expansion fixture, not a shipped language.

Launcher recovery, first-run updater disclosures, Codex-source summaries,
menu-bar unavailable states, and the native status-icon accessibility label
use the same closed catalog. A missing companion therefore has the same
selected-language behavior as the ordinary dashboard and settings controls.

Language choice never changes event time zones, pricing/accounting values, or
provider data: native formatting follows `Locale.current`, and web formatting
uses `Intl` with the regional locale. Translation provenance, contributor
workflow, test requirements, and the future-locale checklist are in
[`docs/decisions/2026-08-03-localization-system.md`](../../docs/decisions/2026-08-03-localization-system.md).

## Preview distribution build

Use the explicit preview channel when a local test client must exercise an
approved deployed HTTPS central service. It is not a production release, and
it is deliberately isolated from the stable client:

- app and bundle identity: `TiboTattle Preview.app` and
  `com.usagemonitor.local.preview`;
- semantic-open route: `usagemonitor-preview://open`;
- local state root: `~/Library/Application Support/Usage Monitor Preview`;
- Keychain namespace/account: `app-usagemonitor.preview.*` and
  `preview-installation`, never stable's existing `app-usagemonitor.*` /
  `installation` pairs; and
- update feed: `/preview/appcast.xml`, never stable's `/appcast.xml`.

The command stages the bundle at
`.release-build/macos-preview/current/TiboTattle Preview.app`, validates those
boundaries, and reports its local path, integrity information, channel, and
updater mode. A newly installed Preview therefore starts without the stable
app's derived index and must build its own schema-11 index from readable local
source history. It is suitable for isolated product smoke, not for proving an
in-place stable-data migration or immediate continuity of stable dashboard
figures; use the signed `internal-dogfood` lane for that release gate, or
rehearse migration against a disposable copy. Launching or replacing a preview
does not migrate, overwrite, read, reset, or delete stable application or
Keychain state. The native plist seals the reviewed namespace/account pair to the
preview bundle identifier, and the companion accepts only that complete pair
or stable's historical pair; arbitrary service/account input is rejected.

The preview command prepares the pinned framework and, by default, uses the
same public central-service origin as the installed TiboTattle client, but a
separate preview appcast path. That makes the ordinary local QA build a real
client of the deployed service without enrolling it in stable updates. The
preview feed may remain unpublished; in that state manual update checks report
unavailable and automatic update opt-in remains disabled. No private release
credential is embedded or read.

An operator may override those **public** values only when deliberately testing
another reviewed deployed environment:

```bash
export USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN='https://APPROVED-DEPLOYED-HOST'
export USAGE_MONITOR_PREVIEW_SPARKLE_APPCAST_URL='https://APPROVED-DEPLOYED-HOST/preview/appcast.xml'
export USAGE_MONITOR_PREVIEW_SPARKLE_PUBLIC_ED_KEY='BASE64_32_BYTE_PUBLIC_KEY='
npm run product:macos:preview
```

To run the two bounded steps separately, use
`npm run product:macos:preview:build` and then
`npm run product:macos:preview:validate`. Preview output is deliberately fixed
to the reviewed staging path; it cannot be redirected with an environment
variable or `--output`. A different Sparkle framework can be supplied with
`USAGE_MONITOR_PREVIEW_SPARKLE_FRAMEWORK`. The build rejects HTTP, IP-literal
and loopback origins, credentials and URL decorations,
malformed public keys, unverified Sparkle trees, and `/Applications` output
paths. It also rejects stable's exact appcast URL even when supplied through an
override, including percent-encoded or slash aliases. The private Sparkle
update-signing key is not an input to this build
and must never be placed in the repository or bundle.

The resulting marker is `preview_distribution` in both the build manifest and
`UsageMonitorBuildChannel`, with `UsageMonitorPreviewDistribution=true` and
`externalDistributionRequested=false`. The central-service runtime key remains
`production_https` so the existing launcher accepts the approved deployed
origin; the separate channel marker, app identity, state root, semantic-open
route, and feed prevent the artifact from being treated as a production
release. Preview builds make **manual** updater checks only: the Automatic
updates switch is disabled and its detail text explains that previews never
automatically check, download, or install an update.

After validation, install it only through the guarded replacement command:

```bash
npm run product:macos:preview:install
```

That command accepts only `/Applications/TiboTattle Preview.app` (or the exact
per-user preview Applications target) and explicitly refuses either stable
`TiboTattle.app` location. It validates the staged preview before and after
copying it, and moves an existing preview to a timestamped sibling backup
rather than deleting it. It requires the explicit `--replace` flag; no preview
build or validation command copies into `/Applications` on its own. The stable
application and `Usage Monitor` state directory remain untouched.

Validate the staged preview without network access by default:

```bash
npm run product:macos:preview:remote
```

The opt-in live check is still credential-free and read-only: it GETs the
configured public health, readiness, and appcast URLs with a five-second bound,
does not follow redirects, and never starts, downloads, or installs an update.
Run it only when checking the published service boundary:

```bash
npm run product:macos:preview:remote:live
# or verify the installed preview directly
node ./scripts/verify-macos-preview-remote.js \
  --app "/Applications/TiboTattle Preview.app" \
  --channel preview_distribution \
  --live
```

If the configured preview feed has no qualifying appcast entry, the command
exits non-zero and says so plainly. That is an external release-input gap, not
a claim that Sparkle has updated the preview client.

## macOS bundle-version allocation

`CFBundleShortVersionString` remains the user-facing package version. The
Sparkle ordering key, `CFBundleVersion`, is explicitly allocated for signed
builds that retain the stable bundle identifier. The 0.1.17 stable allocation
uses build `1024` and accepted runtime basis
`394c8a03a986e0daadbe662679fd002202682e44`; internal RC9 build `1023.7` was the
preceding dogfood allocation. The exact source provenance is the annotated
[`v0.1.17` tag](https://github.com/adamallcock/tibotattle/tree/v0.1.17). A future
signed version/channel must add a reviewed monotonic allocation before release
tooling will run. The untagged 0.1.18 candidate reserves `1025` for dogfood and
`1026` for stable on both architectures; neither allocation proves release or
installation.

Earlier RCs are historical qualification evidence only. The build-1024
release retains the fail-closed source, generation, resource, validation,
atomic-publication, selected-plan Trends, and snapshot safeguards. PR #94
outcome is `passed_with_historical_artifact_refusal` in the
[qualification receipt](../../docs/receipts/2026-09-03-pr94-account-plan-attribution-qualification.md).
Hosted migrations and end-to-end device pairing are not activated by the
desktop release.

Release tooling accepts `USAGE_MONITOR_BUNDLE_VERSION` only when it exactly
matches the checked-in channel allocation, and the signed stable path still
requires the candidate to compare strictly newer than the immediately previous
stable manifest. The exact historical stable `0.x.y` form may be read only as a
previous stable migration source whose bundle and marketing versions match;
new candidates and appcasts must use the strict positive-first Apple form.
Preview has a different bundle identifier and feed, so it retains the
deterministic epoch `(2000 + major).minor.patch` for local ordering; preview
package `0.1.17` therefore uses `2000.1.17` without stranding or advancing the
stable line. Both paths enforce
[Apple's `CFBundleVersion` component limits](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html):
a positive one-to-four-digit first component and optional one-to-two-digit
second and third components.

## External-distribution build gate

External builds require an approved `AppIcon.icns` and a provenance file as
described in [Assets/README.md](./Assets/README.md). No placeholder artwork is
accepted.

Prepare the pinned official Sparkle 2.9.3 binary framework. The command
downloads only the official release archive, checks its pinned SHA-256,
extracts the framework with its required symlinks, validates the exact
framework-tree digest and link targets, and checks the complete license notice:

```bash
npm run product:macos:updater:prepare
```

The generic builder rejects `--external-distribution` entirely, including when
the old environment marker is supplied or a similar CLI marker is attempted.
Build a later stable release candidate only through `product:macos:release`, which performs
the continuity and source-provenance checks before calling the external-build
API. The appcast public key is public; the matching private update-signing key
must not enter the repository or release host:

```bash
npm run product:macos:release -- \
  --channel stable \
  --prepare-candidate \
  --previous-stable-manifest "/path/to/previous-stable-release.json"
```

`--prepare-candidate` does not stop after compilation: this command continues
into Developer ID signing and notarization. It is a protected release action,
not a secret-free build check or dry run.

`--stable-bootstrap` is retained only as the historical first-stable-release
decision and is not the normal current path. Every later stable release must
use the manifest from the immediately previous stable release so the gate can
prove version continuity.

The command rejects a missing origin, HTTP, loopback, credentials, paths,
queries, fragments, missing artwork, missing provenance, placeholder
provenance, invalid bundle versions, an unpinned framework tree, unsafe
framework symlinks, a non-HTTPS appcast, or a malformed Ed25519 public key.
Developer builds reject all updater inputs. The candidate remains ad-hoc signed
until the release command completes.

The release source must be clean and exactly annotated for its channel. Stable
accepts only `vX.Y.Z` matching the short version. Internal dogfood accepts only
`tibotattle-internal-dogfood-X.Y.Z-rcN-source-YYYYMMDD`, with a positive
non-zero-padded `N` and a real calendar date. Lightweight tags, aliases, wrong
versions, and multiple matching channel tags at HEAD fail closed.

External-release bundles set only the outer `.app` Finder creation and
modification dates from the sealed source commit's Git committer timestamp.
Payload files retain the fixed epoch used for reproducible inventories, and the
DMG packager reapplies the same source-bound dates after staging. This
filesystem metadata is outside the signed and inventoried payload; no build-host
wall clock is used for it.

## Developer ID and notarization

The release operator must first make a `Developer ID Application` identity
available in the login Keychain and store notarization credentials in Keychain
without writing them to the repository:

```bash
xcrun notarytool store-credentials usage-monitor-notary
```

Then set only the identity label and Keychain profile name in the release
process environment:

```bash
export USAGE_MONITOR_DEVELOPER_ID_APPLICATION='Developer ID Application: APPROVED OWNER (TEAMID1234)'
export USAGE_MONITOR_NOTARY_PROFILE='usage-monitor-notary'
export USAGE_MONITOR_SPARKLE_FRAMEWORK="$PWD/.release-deps/Sparkle.framework"
export USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY='REPLACE_WITH_32_BYTE_BASE64_PUBLIC_KEY='
npm run product:macos:release -- \
  --channel stable \
  --prepare-candidate \
  --previous-stable-manifest "/path/to/previous-stable-release.json"
```

For a later stable release, use `--previous-stable-manifest` in place of
`--stable-bootstrap`, as shown above. The two options are mutually exclusive;
the release command refuses to guess which continuity policy applies.
`USAGE_MONITOR_BUNDLE_VERSION` is optional as an operator assertion only; when
present it must exactly equal the checked-in allocation for the selected
signed release version and channel (`1023.7` for 0.1.17 internal dogfood,
`1024` for 0.1.17 stable).

`config/deployment-endpoints.js` is the reviewed source for the public origin
and the distinct stable and preview Sparkle appcasts. Legacy
`USAGE_MONITOR_PRODUCTION_ORIGIN` and
`USAGE_MONITOR_SPARKLE_APPCAST_URL` values are accepted only when they exactly
match that manifest, so an independent release-time endpoint cannot slip in.

The release command:

1. derives the exact approved origin and appcast from the reviewed deployment
   endpoint manifest and requires a monotonic bundle version independently of
   the candidate;
2. verifies every regular candidate payload file, mode, size, and digest against the
   build inventory, rejects unlisted entries and symbolic links, and
   normalizes only the reviewed Mach-O signature envelopes for the launcher,
   embedded Node, migration helper, and Sparkle code;
3. rebuilds into an isolated directory from the checked-out source and approved
   inputs, requires the fresh source and payload digests to match the reviewed
   candidate, and discards the candidate bytes;
4. signs Sparkle's Installer XPC, Downloader XPC (preserving its entitlement),
   Autoupdate helper, Updater app, and framework in the upstream-documented
   inside-out order, followed by embedded Node, the migration helper, the native
   launcher, and the outer app. The helper must have the exact legacy Node
   Developer ID designated requirement, the same Team ID, hardened runtime,
   and no entitlements; the finalizer verifies those requirements against the
   actual signatures;
5. applies hardened runtime and a minimal, reviewed Node runtime entitlement
   file;
6. verifies the complete Developer ID signature;
7. submits an app archive to Apple's notary service and staples the accepted
   ticket to the app;
8. creates the DMG with an exact `/Applications` link;
9. submits and staples the DMG;
10. mounts and copies the app into an isolated Applications-shaped directory;
11. runs strict signature, stapler, Gatekeeper, and clean-profile companion
   smokes; and
12. writes a content-free release manifest beside the DMG.

The command never prints or records the identity, notary profile, Apple
credential, or submission identifier. It refuses existing outputs unless the
operator explicitly supplies `--replace`.

## Signed replacement and rollback contract

Production TiboTattle builds use the pinned Sparkle 2.9.3 framework. Sparkle
checks one exact HTTPS appcast automatically and exposes a user-initiated
**Check for Updates** action. Every published artifact must carry an Ed25519
signature made by the offline update key as well as the existing Developer ID
and notarization assurances. Automatic update downloads are on by default in a
signed release. The user can turn them off with the native **Automatic
updates** switch in **Settings…** → **About** and can always use **Check for
Updates** there. A manual signed-DMG replacement remains the fallback.

Every new `usage-monitor-macos-release-v0.2` manifest records the fixed
`usage-monitor-macos-signed-replacement-v1` contract:

- quit TiboTattle before replacing the app in `/Applications`;
- require the candidate bundle version to be strictly newer;
- require both candidate and rollback DMGs to have complete Developer ID,
  hardened-runtime, notarization, stapling, Gatekeeper, and clean-profile
  release assurances;
- retain the same owner-only Application Support root and local Keychain items;
- forbid destructive state migration under this contract;
- require a pre-replacement state backup and explicit compatibility work before
  any future schema change; and
- keep the previous signed/notarized DMG and release manifest as the manual
  rollback artifact.

Before publishing a replacement, retain both DMGs beside their release
manifests and run:

```bash
node ./scripts/validate-macos-replacement.js \
  --previous "/path/to/previous.dmg.release.json" \
  --candidate "/path/to/candidate.dmg.release.json"
```

The validator checks both artifact sizes and SHA-256 values, re-runs notarized
DMG, Gatekeeper, Developer ID, and clean-profile validation on both actual
artifacts, and checks the complete release assurances, fixed signed-updater
contract, bundle identity, and monotonic bundle version. Then rehearse the
candidate against a copy of existing app state. To roll back, quit the candidate
and manually reinstall the retained previous signed/notarized DMG. If a future
candidate ever needs a state schema change, restore the pre-replacement state
backup before launching the previous version unless that exact existing-state
rollback has been rehearsed.

## Automated validation

For menu-bar refresh changes, start with `npm run test:macos:source` and
`npm run test:macos:smoke`. The latter compiles a development-only app and checks
retained history through both the companion's projection and the native view,
including both ranges, read failure, and source reset. Its development-only
`--menu-bar-overview-render-smoke-test <derived-overview.json> <output-directory>`
mode renders ready, updating, and read-failure states without starting a
companion or altering installed app state. Automated fixtures must remain
synthetic; local real-data visual QA is separate from those tests and from an
installed or signed-artifact gate.

Run the focused suite:

```bash
npm run product:macos:test
```

Validate a completed production artifact:

```bash
npm run product:macos:validate:release
```

The automated validator proves the bundle and Gatekeeper contract on the build
Mac with an empty temporary home. It also runs the packaged Login Item contract
smoke against an injected fake manager; that check makes zero real
ServiceManagement calls. It is not a substitute for a truly clean machine.
The manual clean-profile and physical Login Item matrix remains deferred; see
the [native release plan](../../docs/plans/2026-09-03-public-0.1.17-release.md).

For Finder metadata, inspect the app directly on the final frozen DMG, read-only,
after stapling. Derive the expected timestamp from the sealed source commit in
`build-manifest.json`, then compare the outer bundle's creation and modification
dates with that source-derived value. The isolated `ditto` copy used for
clean-profile smoke is not evidence of mounted-volume Finder metadata.

Before sending the DMG to any external user, perform a human clean-Mac or
disposable-VM rehearsal:

1. transfer the DMG through the intended download channel so quarantine
   metadata is present;
2. confirm the browser-reported checksum against the release manifest;
3. open the DMG and drag the app to `/Applications`;
4. launch it without Terminal, Control-click bypasses, or privacy-setting
   exceptions;
5. verify the calm Ready state, Retry path, diagnostics copy and failure code,
   default/custom Codex source selection, exact configured app-open link,
   first scan, first reviewed contribution, opt-in six-hour contribution
   schedule, **Check for Updates**, close/reopen from the menu bar, explicit
   quit, relaunch, and uninstall journey; and verify the notification Settings
   contract: off by default; permission requested only after opting in; one
   controlled fresh direct-provider threshold crossing; no alert for first,
   stale, inferred, mixed, unknown, unobserved, or failed refresh evidence;
   one scheduled reset alert on the next eligible refresh at or after the
   provider-reported due time, with dedupe across relaunches;
   and opt-out stops future alerts without erasing accounting evidence;
6. on a disposable clean macOS user profile, verify that first-run visibly
   preselects **Start TiboTattle at login** but does not create a Login Item
   until **Get Started** is chosen; then verify the Settings status, explicit
   status refresh after returning from System Settings, disable/re-enable, and
   the approval/System Settings/**Remove Pending Login Item** recovery paths.
   Sign out/in once to prove automatic launch; then rehearse signed upgrade,
   move/reinstall, uninstall/reinstall, and an attempted second launch to
   confirm one normal-app Login Item and no stale duplicate. Confirm that the
   only possible Login Item is TiboTattle's native app registration, and that
   there is no LaunchAgent, LaunchDaemon, daemon, privileged helper,
   unexpected network connection, autonomous raw-log scan, background upload,
   or orphan companion; and
7. retain the macOS version, hardware architecture, artifact SHA-256, elapsed
   onboarding times, and observed failures in the release receipt; then run
   the receipt gate without changing Login Items:

   ```bash
   npm run product:macos:validate:login-item-release -- \
     --app "/Applications/TiboTattle.app" \
     --rehearsal "docs/receipts/YYYY-MM-DD-macos-login-item-release-rehearsal.json"
   ```

## Protected per-release inputs and gates

The repository cannot complete a new release without an authorized person. A
previously published release does not satisfy these gates for later bytes:

- approve final icon artwork and its distribution rights;
- supply and authorize an Apple Developer Program team and Developer ID
  Application certificate;
- create the `notarytool` Keychain credential profile;
- verify the reviewed production HTTPS service origin;
- create and protect a Sparkle Ed25519 update-signing key outside the
  repository and hosting environment;
- approve and publish the exact HTTPS appcast URL;
- publish an Ed25519-signed, Developer ID-signed, notarized update artifact and
  rehearse both an update and rollback;
- accept any Apple or hosting legal/billing terms;
- run the quarantine-preserving clean-Mac rehearsal;
- approve consumer privacy, consent, support, update, and incident-response
  copy; and
- authorize external distribution.

The repository implements and tests the fail-closed updater build boundary.
Current source, signed candidate, notarization, publication, feed availability,
installed upgrade, and rollback rehearsal remain separate gates recorded in
the [current status matrix](../../docs/current-status.md).
