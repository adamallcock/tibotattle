---
title: Current-Source Browser QA Receipt
date: 2026-07-29
type: verification-receipt
status: development-verified-with-rendered-recovery-delta
---

# Current-source browser QA receipt

## Scope

This receipt covers the rendered consumer journey captured on July 29, 2026,
plus a final, narrowly bounded stale-device recovery change that was
source-reviewed, contract-tested, dual-runtime-qualified, and rebuilt into the
development DMG/site after the browser session ended. The rendered baseline
and final-source delta are identified separately below. This is
local-development evidence, not proof that any public URL, hosted backend,
signed installer, or participant service exists.

The browser loaded:

- the artifact-bound static acquisition build at
  `http://127.0.0.1:8910/`; and
- the real local companion at `http://127.0.0.1:8911/`;
- isolated first-run companions at `http://127.0.0.1:8920/`; and
- a disposable contribution companion and Worker at
  `http://127.0.0.1:8931/` and `http://127.0.0.1:8932/`.

Every server was bound to loopback. The public-build URLs under
`smoke.usagemonitor.app` and `downloads.usagemonitor.app` were non-published
build inputs and were not opened.

## Source and artifact binding

The rendered dashboard baseline and final qualified source hashes were:

| Source | Rendered baseline SHA-256 | Final qualified SHA-256 |
| --- | --- | --- |
| `apps/web/public/index.html` | `eba0f51deacde3e18cba8b11f2cf68b9a1874f1af89413ce12b243431a294853` | same |
| `apps/web/public/app.js` | `15420e23535c722d1afb57c6ca66547d51d72b15dbd30a6a8c39a766ff0de3b8` | `9636a4374a1b078b99ec2ebcf5930bf2b818d91fff4703d8c7ee29f635dfe06c` |
| `apps/web/public/data-client.js` | `b2c14d7bb96100ca4987e5df13be7a03899f9fa4aff70d29df5aeef0eec6b175` | `c86e42be511dd724812fc0557f66fbefd4a7cd3d32970a56297582abbf0d1eea` |
| `apps/web/public/lib.js` | `8982b7c35e72535c79c76da1b30d9e1b6fdacff8a413bb55e3a9585c683e563e` | same |
| `apps/web/public/styles.css` | `e53014efa8d4457a5449ebec440ba1871119e2fc619b956895936cea0a23ec3d` | same |

The rendered baseline bytes were replaced when the final app and site were
rebuilt and were not retained as a second source tree. Its column is therefore
a contemporaneous hash receipt corroborated by the screenshots and recorded
browser observations, not an independently replayable baseline artifact. The
final qualified column and recovery harness are retained and replayable.

After the rendered pass, `app.js` and `data-client.js` changed only to preserve
the exact content-free `contribution_device_recovery_required` loopback error
and render the existing two-confirmation native reset path. The server,
client, and UI delta passed 78 focused tests, the integrated local/UI gates,
and both full supported-runtime suites. Its injected conflict test proved two
retries caused zero credential creates, zero credential deletes, and zero
network calls. A disposable native WebKit harness then extracted and executed
the exact current `node` and `renderContributionDeviceRecovery` functions with
the current stylesheet. Runtime DOM assertions verified the fixed copy, error
class, both-confirmation instruction, and `usagemonitor://open` target before
the mode-`0600` snapshot was written. This visual harness did not enroll a
participant, touch Keychain, call a network service, or click the reset. The
receipt must not be used if any final qualified source hash changes.

The rendered static-build manifest SHA-256 was
`9856ee1fb35b7e36bc7d0827b114f3726ae444cbb7839af8af7ced43c9c255e8`.
The rebuilt final-source manifest SHA-256 is
`e082586cfffad3074dcb55b85513ca0d4dca514e0540c580f3e3ac5ae92db050`.
The release-site builder deliberately injects artifact-bound installer,
canonical, support, privacy, security, and social metadata into a generated
copy of `index.html`. The unchanged source file above is therefore `eba0…`;
the rendered baseline recorded transformed output `ab004ece…`, while the
rebuilt final output is
`1b51959262eb2cb1cd85ba966adf5d8d1b35a6feb48e2258a303dfee04961448`.
They are different, intentionally bound artifacts. The final build binds:

- development DMG SHA-256
  `2a6ab3796e773bf71e60fa6a6f2e17bd27613784885b5674b0e171be80f75e0c`;
- development DMG size **45,657,009 bytes**;
- version `0.0.1`, macOS 13.0 or later, Apple silicon;
- the 1200×630 PNG with SHA-256
  `ef643f7f4a8058c43f0c89b92b3cb83fc48319f8383c3bfb8deda4f16f8a5e7d`;
  and
- seven manifested site files plus the manifest itself.

## Rendered observations

The public acquisition build:

- clearly said a normal website cannot read Codex files;
- displayed the exact installer version, compatibility, 44 MiB rounded size,
  and full DMG digest;
- presented Download, Open installed app, release notes, privacy, security, and
  support targets;
- said real usage appears only in the loopback tab; and
- rendered the local-versus-optional-contribution privacy boundary without
  displaying demo or real local usage.

The real local companion:

- rendered `Local-only mode` and did not claim a hosted service was connected;
- detected the local Codex installation and writable private app state;
- loaded cached content-free results immediately, completed one bounded refresh,
  and reached `Live local evidence`;
- scheduled one new bounded refresh after a reload; cancelling it rendered
  `Local analysis cancelled`, retained the verified results, and kept a
  resumable local checkpoint;
- rendered the main timeline with API-equivalent USD on the left axis and
  allowance remaining percent on the right axis;
- used `America/New_York` browser-local labels;
- rendered the seven-day estimate as **$1,832 API equivalent**, with the
  across-reset 80% range **$1,395–$2,170** and explicit multi-account caveat;
- kept advanced calibration collapsed by default; and
- rendered the current 31-day weekly history and evidence filter.

The usage-chart date range and advanced-calibration controls were exercised
independently. Selecting usage `24h` left calibration at `7d`; after opening
advanced calibration, selecting `3 hours` left the usage range at `24h`.
Controls were restored to usage `7d`, calibration `7d`, rolling window
`1 hour`, with advanced calibration collapsed.

Both tabs returned an empty browser console/dev-log collection for this pass.

## First-run and timing observations

Two isolated owner-only homes verified the new-user failure guidance:

- with the normal `~/.codex` location absent, the page rendered **Open Codex
  once, then check again**, kept Analyze disabled, and offered Check again;
- with empty `sessions` and `archived_sessions` directories, the page rendered
  **Complete one Codex response, then check again**, kept Analyze disabled, and
  explained that no completed local task was detected; and
- neither page exposed a source path or produced a browser warning/error log.

A separate rendered-baseline real-local run recorded the Analyze action at
`2026-07-29T11:31:41.177Z`. A usable quota and recent-cost result was visibly
available when checked no later than 25 seconds afterward. This is an observed
upper bound, not a benchmark distribution.

The same disposable state then recorded an exact cached/continuation refresh:

| Event | UTC timestamp |
| --- | --- |
| Started | `2026-07-29T11:38:05.222Z` |
| Quick result | `2026-07-29T11:38:07.402Z` |
| Finished | `2026-07-29T11:39:55.321Z` |

The quick result took **2.180 seconds** and the complete bounded pass took
**110.099 seconds**. It discovered 2,964 rollout files, selected and processed
680 recent files, and retained 681,587 content-free records. Because the
second measurement reused the disposable cache, it qualifies return-use and
bounded-continuation behavior; it must not be presented as clean-install
latency.

## Disposable contribution, recovery, and deletion

The browser completed one fresh, disposable participant journey against
verified local Worker/D1/R2 state:

1. consumed one fresh owner-only invitation and created a recovery capability;
2. acknowledged the recovery capability without writing it to this receipt;
3. paired an upload-only local device;
4. prepared the latest hour locally as seven batches containing about 1,300
   content-free records and 1.4 MB, with no upload during preparation;
5. opened the exact review for the first batch and verified 80 records
   (38 usage and 42 quota), a `$4.015008` local API-price estimate, 100% price
   coverage, 84.2 KB prepared, and 176.7 KB reserved;
6. verified that the exact review contained no prompt, response, command, path,
   or email field, then explicitly pressed Send;
7. received one accepted-batch receipt and a private result containing 38
   usage events, 42 quota snapshots, `$4.02` server-repriced API equivalent,
   and 100% priced-event coverage;
8. requested the content-free participant export; the Worker returned HTTP
   200, but the downloaded file was deliberately not retained;
9. signed out, recovered with the saved capability, and verified that the
   replacement recovery capability rotated without exposing either value;
10. deleted the accepted batch and verified that private statistics became
    unavailable;
11. deleted the disposable participant capability and verified that a fresh
    page returned **No personal result is available**; and
12. ran scheduled lifecycle maintenance, which reported retention, restore
    replay, quarantine reconciliation, and aggregate rebuild complete before
    `/api/ready` returned HTTP 200 again.

The post-deletion state returned to the 20-participant generated-fixture
baseline: 20 active participants, 20 accepted contributions, 40 canonical
records, 40 occurrences, 20 retained quarantine references, no extra active
session or device from the disposable participant, and one digest-only
deletion tombstone.

This browser pass deliberately injected an in-memory contribution-device
credential backend into the temporary companion. That exercised the
connection, preparation, review, send, recovery, and deletion application
paths without reading, overwriting, or deleting the machine's pre-existing
Keychain item. The final source now detects an already-present Keychain
credential whose local binding file is missing, returns one fixed recovery
code, and directs the user to **Data & Diagnostics… → Identity & Device
Reset…** with both native confirmations. That branch is source- and
contract-qualified and visually rendered from its exact current function. It
is not proof of a signed clean-Mac Keychain reset. The repair/reset remains an
explicit user action and never silently mutates local or hosted state.

Browser warning/error logs were empty after the final lifecycle and first-run
passes. All temporary listeners were stopped. The disposable homes, Worker
state, invitation, participant capabilities, and companion state were moved
recoverably to Trash rather than silently deleted.

During command discovery, an attempted `grant:issue --help` invoked the
no-help command and issued one unredeemed default-local invitation. It was
removed immediately with its exact identifier, secret hash, and
`state='issued'` predicate; the cleanup receipt reported `removed=1` and
`identifier_exists=0`. No other invitation was touched and the capability was
not displayed.

## Visual artifacts

The generated screenshots are deliberately kept under the ignored
`.release-build` tree:

| View | SHA-256 |
| --- | --- |
| `browser-qa-2026-07-29/public-release-site.png` | `febddbc0bc48545b0299bdec0dcb8563abb0429dd3f288d887a1e189dc35af68` |
| `browser-qa-2026-07-29/local-dashboard-overview.png` | `70a1c515c2737e7b35999652b9f52531671fc96b2478ba9ac23f9dc8a51e70cc` |
| `browser-qa-2026-07-29/local-dashboard-timeline.png` | `fdfc6c7fb9eacd16f194893290125584b2dc779f05903c3d75a2705cbe62fed7` |
| `browser-qa-2026-07-29/local-dashboard-weekly.png` | `100edf62c1ca422bd28467225eb450982a3e47a7602e960b5a6c7aee5c1cd790` |
| `browser-qa-2026-07-29/no-codex-first-run.png` | `3a082bda70a172e9dbce40bf2638331f8e22ce6da8ba1397852cccb37c2a5f9d` |
| `browser-qa-2026-07-29/empty-codex-first-run.png` | `fbbb2708a15941f5fd208bb59ea4bc7c0e1575dde5337082bb3345e4bf803711` |
| `browser-qa-2026-07-29/contribution-deleted.png` | `2ae1488acdf615eca77b268cc05a310dde49491bcaf4bb542c76fedd2e1feb2e` |
| `browser-qa-2026-07-29/stale-device-recovery.png` | `305ce85d64d170f4c766f87ff642322d4cba7bf7553224c77a03fe9d53824d72` |

Every local, onboarding, and lifecycle screenshot is mode `0600`; the
content-free public page is mode `0644`.

`contribution-deleted.png` shows the restored green backend and local-evidence
state at the top of the contribution section after maintenance. The stronger
deletion assertions—no personal result, baseline database counts, HTTP
deletion receipts, and successful maintenance—come from the DOM, Worker
responses, and state inspection recorded above, not from text visible inside
that screenshot.

`stale-device-recovery.png` is a 2560×1520 PNG from a 1280×760-point native
WebKit viewport showing the exact final recovery renderer and stylesheet.
Before capture, the harness asserted
that the runtime DOM contained the non-upload/non-mutation warning, the
**Identity & Device Reset…** and both-confirmation guidance, the fixed error
class, and the `usagemonitor://open` link. It is visual evidence for the final
UI branch, while the injected server/client tests remain the evidence that the
branch is reached safely and performs no mutation or network request.

The retained mode-`0600` harness is
`.release-build/browser-qa-2026-07-29/stale-device-recovery-harness.swift`,
5,944 bytes, SHA-256
`e5b57394ed40cea13d1b1bd36f0b994b251dec2a07994e313f6cb47a9b62d821`.

## Exact verification commands

```bash
python3 -m http.server 8910 --bind 127.0.0.1 \
  -d .release-build/release-site-smoke-final

USAGE_MONITOR_PORT=8911 npm run product:local

shasum -a 256 \
  apps/web/public/index.html \
  apps/web/public/app.js \
  apps/web/public/data-client.js \
  apps/web/public/lib.js \
  apps/web/public/styles.css \
  .release-build/release-site-smoke-final/release-site-manifest.json \
  .release-build/browser-qa-2026-07-29/*.png

APP_JS_PATH="$PWD/apps/web/public/app.js" \
CSS_PATH="$PWD/apps/web/public/styles.css" \
SNAPSHOT_PATH="$PWD/.release-build/browser-qa-2026-07-29/stale-device-recovery.png" \
swift .release-build/browser-qa-2026-07-29/stale-device-recovery-harness.swift
```

## Boundary

This pass does not prove Developer ID signing, notarization, Gatekeeper on a
clean Mac, the availability of any public destination page, a provisioned
remote backend, execution of the packaged two-confirmation Keychain reset, or
the hosted contribution lifecycle from the current DMG. Those remain separate
human-controlled release gates. The packaged recovery routing itself is
implemented and contract-qualified; it is not an unresolved retry loop.
