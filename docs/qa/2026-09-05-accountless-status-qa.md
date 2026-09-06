---
title: Accountless sharing transport status synthetic UI QA
date: 2026-09-05
type: qa
status: completed-synthetic
---

# Accountless sharing transport status synthetic UI QA

This is source-and-fixture evidence only. It does not qualify an installed
Electron build, a normal desktop profile, a production endpoint, or a real
upload.

## Isolated fixture

The scratch fixture at `/private/tmp/accountless-status-qa-fixture.mjs` serves
the current `apps/web/public` files over an ephemeral IPv4 loopback URL. It
injects a synthetic `window.tibotattleDesktop` bridge before the application
modules load. The bridge supplies only fixed demo overview data and a chosen
sharing preference; it has no credential, profile, central-origin, or network
capability.

The fixture accepts `transport` query values `unavailable`, `off`,
`uploading`, `pending`, `up_to_date`, `retry_wait`, and `paused`. Passing
`enabled=0` makes the synthetic preference and transport state `off`.
Its server binds only `127.0.0.1` and serves a same-origin-only CSP. No normal
browser profile, real user data, or external request was used.

## Static checks completed

The Community dashboard and Settings page both accept the same seven transport
values during preference normalization and map them to the same localized
message keys. The Community page binds the persisted preference to the
`Share usage measurements` switch. Settings presents the matching state and
transport text and directs its management action to Community, so it does not
provide a competing preference control.

The current English catalog distinguishes these active states:

| Synthetic value | Expected text |
|---|---|
| `uploading` | Sharing eligible usage and quota metadata… |
| `pending` | More eligible data is waiting to be shared. Sharing will continue while the app is open. |
| `up_to_date` | Sharing is up to date. New eligible data will be checked while the app is open. |
| `retry_wait` | Sharing is waiting to retry. Local analysis remains available. |
| `paused` | Sharing is paused because upload permission could not be verified. |
| `off` | Uploads are disabled while community sharing is off. |
| `unavailable` | Uploads are not available in this build. |

The new `pending` state is therefore separate from `up_to_date`: it tells the
user that eligible data remains queued and that the while-open scheduler will
continue, rather than claiming that sharing has settled.

The browser catalog mirror has matching English, Simplified Chinese, and
Spanish values for every listed status.

## Rendered checks completed

Headless Chrome 152 rendered the six active-and-off states at 1440 by 1080
with one disposable profile and only the loopback fixture available to it. The
run captured Community and Settings for each state: 12 images total. Its DOM
probe waited for the exact localized transport message, checked the displayed
preference and Community switch state, verified the Settings `Manage sharing`
action was available, and rejected scroll overflow on each state or transport
message. All 12 captures passed.

The captures and their structured result are scratch-only artifacts under
`/private/tmp/accountless-status-qa/`; `headless-status-results.json` records
the URL, visible strings, control state, and overflow result for every
capture. Visual review covered pending on Community and Settings, off on
Community, and paused in Settings. The messages fit in their cards, Community
showed a checked switch when sharing was on and an unchecked switch when it was
off, and Settings showed the same preference and transport wording while
providing its single route to the Community control.

This is still synthetic browser evidence. It does not qualify packaged
Electron, a normal browser profile, keyboard or assistive-technology behavior,
or any actual upload.

## Transport replay boundary

The client tests cover a mismatched ownership receipt preventing the v1.1
runner and a lost committed usage or quota response resuming through the local
manifest without a duplicate POST or early cursor acknowledgement. The Worker
ownership route and its D1-backed ledger are not yet available, so there is no
client-to-Worker E2E evidence.

The current client intentionally keeps a terminal pause in memory. A restarted
client can retry enrollment using the same protected installation binding; it
does not mint a new binding. The future Worker ledger must return the existing
or revoked result and prevent v1.1 upload before this restart path can be
considered proven.

## Manual continuation

When a disposable graphical surface is available, start the fixture in one
terminal:

```sh
node /private/tmp/accountless-status-qa-fixture.mjs
```

Then use the emitted loopback URL with the capture helper and a new disposable
Electron user-data directory. Capture Community and Settings separately for
each active state, including `pending` and `enabled=0`:

```sh
node_modules/.bin/electron /private/tmp/accountless-status-qa-capture.mjs \
  'http://127.0.0.1:PORT/index.html?transport=pending' \
  /private/tmp/accountless-status-qa/pending-community.png \
  1440x1080 /private/tmp/accountless-status-qa-userdata/pending-community

node_modules/.bin/electron /private/tmp/accountless-status-qa-capture.mjs \
  'http://127.0.0.1:PORT/electron-settings.html?transport=pending' \
  /private/tmp/accountless-status-qa/pending-settings.png \
  1440x1080 /private/tmp/accountless-status-qa-userdata/pending-settings
```

Replace `PORT` with the fixture's emitted port. Verify the visible text,
unclipped dimensions, accessible status announcements, and that Community and
Settings show the same preference after a synthetic toggle. Keep the capture
profile and image output under `/private/tmp`; neither belongs in a release
artifact.
