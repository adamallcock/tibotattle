---
title: Contribution and Updater Product Plan
date: 2026-07-29
type: plan
status: implemented-development-foundation
---

# Contribution and updater product plan

## Outcome

The development foundation now presents a simpler consumer product whose
personal value is immediate and whose optional community contribution follows
an explicit reviewed first send. The source is organized for private-GitHub
transparency, and the macOS release path contains a fail-closed Sparkle
foundation for signed updates. Public distribution, real-user collection, and
a live update remain human-gated.

The current implementation and verification boundary is recorded in the
[consumer contribution and updater verification report](../reports/2026-07-29-consumer-contribution-and-updater-verification-report.md).

## Product boundary

- The installed Mac app is the consumer product and lifecycle owner.
- Its private loopback dashboard is the canonical personal reporting surface.
- The hosted website is the acquisition, documentation, public-community and
  central-service surface. It cannot read local Codex files.
- The app may display public community aggregates through its fixed central
  proxy. A contributor is not redirected away from the local dashboard to see
  their own results.
- Intel Mac, Windows and Linux packaging remain secondary until the Apple
  silicon Mac journey is signed, hosted and observed with real users.

## Measured analysis experience

Current July 29 evidence on this Mac supports the following honest copy:

- a useful headline result was observed in 2.180–25 seconds;
- a cached complete deep pass took 110.099 seconds for 680 selected files and
  681,587 content-free records; and
- a larger uncached observed run produced a useful result in about 20 seconds
  and completed in about 5 minutes 27 seconds.

These are local observations, not population latency promises. The UI should
say that a first deep pass usually takes a few minutes and that later updates
are normally faster.

A later packaged clean-state pass completed all 714 bounded files and deep
synthesis without error. A same-state companion relaunch restored prior
results immediately, published a fresh headline in about 21 seconds, and
completed the cached refresh in roughly 2 minutes 1 second to 2 minutes 31
seconds. This remains one-machine evidence rather than a service-level target.

The latest refresh path reuses a current replay-safe accounting cache when the
collector writes only a new quota observation. Any genuinely new rollout usage
still rebuilds through the bounded 31-day scan. The accounting builder now
receives the existing export resource guard for source files and bytes,
directory entries, elapsed time, line size, and RSS, including a measured 1.5
GiB RSS ceiling. A violation maps to fixed `refresh_resource_limited`; the UI
retains the useful headline or previous result and explains that deep analysis
stopped at its safety limit. Treat this as a pilot-safe bound. A future
persistent incremental accounting index should still eliminate full-window
replay after new usage for fast complete scans of very large histories, but is
not a safe-pilot blocker.

The browser permits the initial bounded pass plus exactly two automatic
continuations. Each accepted pass has a six-minute polling window around a
five-minute server ceiling, producing a finite roughly 18-minute one-click UI
budget. If work remains, the app retains the headline and verified state,
reports **Deep analysis paused after two bounded continuations**, and lets the
user resume later.

Passive recursive discovery is abort-aware and capped at 20,000 directory
entries and 5,000 rollout files per pass. The byte ceiling covers new files,
appends, truncations, and reseeding. Resource pauses preserve durable cursors
and emit fixed content-free evidence, and the foreground collector inherits
the same policy.

## Source transparency

1. Keep the GitHub repository private until privacy, licensing and release text
   are approved. The configured
   [`adamallcock/app-usagemonitor`](https://github.com/adamallcock/app-usagemonitor)
   remote was verified `PRIVATE` on July 29, 2026.
2. Put all first-party source required to build the app, local companion,
   website and backend in the repository.
3. Exclude raw logs, derived local reports, credentials, local state, signing
   material and release artifacts.
4. Preserve a reproducible source inventory and third-party notices.
5. Before a public switch, choose and approve the first-party source license.
   No first-party `LICENSE` or `COPYING` file exists today. A public repository
   without a license would be source-visible but not open source.
6. The completed reviewed source was committed and pushed to the existing
   private remote as `26050e3b2ecbbb429cca4fe1ace1c08e1b1af639` after the
   staged patch and full history passed renewed secret scans. Production
   release artifacts remain separately human-gated.

## Configurable product target

One reviewed product-brand configuration now centralizes:

- display name;
- bundle name and executable name;
- bundle identifier;
- stable custom URL scheme and semantic open host;
- local state-directory name; and
- monitored-product display name.

The native launcher reads the stamped values from its bundle rather than
hard-coding the consumer-facing semantic target. Display branding and the URL
scheme remain separate, so a future rename cannot silently break installed
links. The same reviewed semantic-open placeholder is stamped from
`PRODUCT_BRAND` into loopback and public-site output; a missing or duplicate
placeholder fails closed.

## Contribution journey

### Main call to action

After the first useful local result, the dashboard shows a prominent card:

> Help map Codex limits
>
> Contribute content-free pseudonymous metadata so the community can measure
> how limits differ over time. Prompts, responses, commands, paths, account
> names and credentials never leave this Mac.

The primary affirmative action is **Contribute and keep it current**. A quiet
**Not now** action remains available. Consent is never pre-checked or inferred
from installing, opening or analyzing.

### First contribution

The affirmative journey now:

1. show the exact retained metadata categories;
2. obtain one explicit contribution consent;
3. connect an upload-only installation capability;
4. prepare a bounded recent interval locally;
5. show a concise human review plus expandable exact JSON;
6. send only after confirmation;
7. require the service to accept at least one upload from that exact reviewed
   prepared set before recurring contribution can be enabled; any remaining
   jobs stay bound as the pending set and must be resolved before a new range;
   and
8. display a receipt with the covered interval, records, bytes and next
   scheduled attempt.

Recovery-code acknowledgement, multi-device management, personal server export
and access-reset controls are removed from the ordinary consumer journey.

### Periodic contribution

- Offer **Contribute automatically every 6 hours while Usage Monitor is
  running** as part of the explicit affirmative action.
- Do not install a daemon, LaunchAgent or login item in this release.
- Persist an owner-only consent receipt bound to the exact telemetry schema,
  field dictionary, privacy contract and central-service origin.
- A schema, destination or privacy-contract change disables automatic
  contribution until consent is renewed.
- Persist an owner-only accepted-through watermark bound to the destination,
  telemetry schema, field dictionary, and privacy contract.
- Prepare from that accepted-through watermark with a fixed one-hour replay
  overlap for server-side deduplication and at most 24 hours of covered
  evidence per pass.
- Persist an owner-only settings-v0.3 write-ahead claim with one stable
  preparation ID and exact range contract before filesystem publication.
  Re-enter that exact attempt after interruption, verify retained review,
  staging, or published evidence, and do not prepare a new range while the
  claim remains.
- Bind the derived prepared-set ID into the active claim before publication so
  maintenance protects it through recovery and the transition to pending
  upload.
- Request cooperative abort at a five-minute deadline, cap one pass at 100
  upload jobs and 64 MiB, and wait for active cleanup before releasing the
  single-instance lock. Catch up longer offline intervals across successive
  24-hour passes, and fail closed for repair if more than 256 unresolved
  prepared sets accumulate.
- Advance the watermark only after the exact prepared set reaches durable
  terminal acceptance or idempotent replay acceptance. Never advance it for a
  partial, retryable, rejected, aborted, or timed-out result.
- Use fixed per-pass record, batch, byte, retry and time ceilings.
- Show last success, next due time and a visible pause control.
- If the backend or credential is unavailable, retain a bounded local queue and
  retry later without interrupting personal reporting.
- Retire only prepared sets whose every queue job is terminally accepted and
  whose bounded artifact path passes the owner-only canonical-root checks.
  Protect the reviewed first-send evidence and every active claim or pending
  set from automatic retirement, make an unprotected fully accepted set
  eligible when it is older than seven days or beyond the eight most-recent
  accepted sets, remove its artifacts before compacting accepted queue rows,
  and retire at most sixteen eligible sets per pass. Never retire retryable,
  in-flight or rejected work.
- Never interpret install, app launch, local analysis or an old manual upload
  as recurring consent.

## Privacy-control simplification

The uploaded rows include exact timestamps and a persistent pseudonymous
installation capability. They are privacy-minimized, but not proven anonymous.
Therefore:

- remove recovery, export and reset from the primary product surface;
- keep local app-data erase under native troubleshooting controls;
- keep a narrow hosted deletion mechanism and bounded retention;
- place the deletion action under a quiet **Privacy controls** disclosure or
  support route;
- do not describe contributions as anonymous until a formal unlinkability and
  aggregation review supports that claim; and
- continue publishing only delayed, thresholded, clipped and rounded community
  aggregates.

## Updater

Adopt the official Sparkle 2.9.3 binary framework directly. The implementation
uses upstream Sparkle behavior and notices; no CodexBar source is copied.

### Development implementation

- The updater abstraction has disabled and Sparkle-backed modes.
- Sparkle 2.9.3, its official archive digest, exact framework-tree digest,
  symlink inventory, and complete notice are pinned.
- `SUFeedURL`, `SUPublicEDKey`, signed-feed requirements, automatic checks, and
  the opt-in update policy are stamped only into external-distribution builds.
- Ad-hoc/development builds reject updater inputs, omit
  `Sparkle.framework`, and perform no updater networking.
- Production builds expose **Check for Updates…**. Automatic download and
  install-on-quit are off by default and become active only after the user
  opts in; the user can turn them off again.
- The release path signs Sparkle's nested helpers before the framework and
  outer app.
- The positive external-distribution test explicitly prepares the pinned
  Sparkle framework and runs the complete updater configuration path without a
  skip fallback. A repeated preparation independently verifies and reuses the
  exact pinned framework; aliases or modified contents fail closed.
- The complete Sparkle notice is included. No CodexBar notice is needed because
  no CodexBar source was copied.
- The manual signed-DMG replacement and rollback validator remains the recovery
  path.

### Human production gates

- approve a stable HTTPS appcast and download origin;
- generate and protect a Usage Monitor Ed25519 update keypair;
- provide Developer ID and notarization credentials;
- sign the appcast and archive;
- verify update from the previous notarized release on a clean Mac; and
- approve stable-versus-beta channel policy.

## Deferred menu-bar direction

No menu-bar item is implemented in this foundation. If later evidence supports
one, add a small AppKit status item after the core journey is stable. It should
show:

- current weekly allowance and freshness;
- Open Dashboard;
- Refresh local data;
- Contribute now;
- automatic-contribution state and last success;
- an update-ready action; and
- Settings and Quit.

The menu bar is a shortcut and status surface, not a replacement for the full
reporting interface. Do not copy CodexBar's large multi-provider controller.

## Acceptance criteria

- Implemented and locally tested: a user can open the self-contained
  Apple-silicon Mac app and reach a useful personal result without Terminal.
- Implemented and observed: first-use copy says a deep pass can take a few
  minutes, backed by the July 29 timing observations rather than an unsupported
  universal promise.
- Implemented and rendered: a completed result leads to the
  **Help map Codex limits** call to action.
- Implemented and tested: no contribution happens before explicit consent,
  exact review, and first-send confirmation; recurring contribution additionally
  waits for accepted first-upload evidence.
- Implemented and tested: the six-hour foreground schedule persists across app
  relaunch, prepares a watermark-bounded overlap, and reports last/next status.
  Same-origin relaunch coverage proves persisted consent retains three hours
  until the next attempt and an overdue attempt is scheduled with zero delay.
- Implemented, regression-tested, and independently re-audited: interrupted
  preparation resumes one write-ahead-claimed attempt without orphaning or
  replacing its retained artifacts, and shutdown holds the instance lock until
  active work quiesces.
- Implemented and rendered: recovery/export/reset/device management do not
  appear in the ordinary contribution journey.
- Implemented and tested: quiet hosted deletion, retention, and backend
  lifecycle controls remain available.
- Implemented and tested: development builds perform no updater check and
  contain no Sparkle framework.
- Implemented and tested as a fail-closed release foundation: production
  updater configuration requires the exact pinned framework, HTTPS feed URL,
  canonical public key, and signed/notarized release path.
- Implemented and tested: the public release builder accepts only the primary
  `arm64` pilot artifact and rejects Intel-only or universal architecture
  claims.
- Completed: the reviewed source was committed and pushed to the existing
  private GitHub repository as `26050e3b2ecbbb429cca4fe1ace1c08e1b1af639`
  with no raw logs, secrets, or release artifacts.

## Remaining human and cloud gates

The live read-only Cloudflare probe on July 29, 2026 returned
`state: blocked`, `collectionAuthorized: false`, and exactly:

- `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED`; and
- `R2_NOT_ENABLED`.

Those codes mean an authorized owner must enable R2, accept any billing/terms,
create the two real D1 databases and private R2 bucket, replace the sentinel
resource identifiers, install the two envelope secrets, apply both migration
streams, verify the pilot schema and fully contained collection-control row,
approve the production domain/origin, and authorize disabled-first deployment.
Only a later human decision may activate invitations or real-user collection.

The contained Cloud Run/GCS experiment remains collection-disabled and is not
the pilot backend. Its template still requires an authorized project, private
bucket, readiness marker, runtime service account, immutable image digest,
Cloud Run API/billing, rendered configuration, IAM review, and deployment
authorization.

The separate release gates are an approved first-party source license, final
privacy/consent/support text and jurisdictions, final icon and rights,
Developer ID and notarization credentials, a protected Sparkle private key,
approved HTTPS appcast/download/site/service origins, signed feed and archive,
clean-Mac install/update/rollback rehearsal, and explicit publication and
participant-collection authorization.
