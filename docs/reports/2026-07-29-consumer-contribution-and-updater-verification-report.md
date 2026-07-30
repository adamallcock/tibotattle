---
title: Consumer Contribution and Updater Verification Report
date: 2026-07-29
type: verification-report
status: ready-for-human-gates
supersedes: 2026-07-29-end-to-end-pilot-readiness-report.md
---

# Consumer contribution and updater verification report

## Verdict

Usage Monitor now has a coherent end-to-end development foundation for its
primary Apple-silicon Mac pilot:

- the installed app owns local collection and lifecycle;
- the app opens a private loopback personal dashboard;
- the hosted site is limited to acquisition, downloads, documentation, and
  delayed public community aggregates;
- the first contribution requires explicit consent, exact local review, an
  explicit send, and at least one accepted upload from that exact reviewed
  prepared set;
- only that accepted first send can unlock an optional six-hour while-open
  recurring schedule;
- the ordinary contribution journey omits recovery, account reset, personal
  server export, and multi-device management while preserving quiet hosted
  deletion;
- external-distribution builds have a pinned Sparkle 2.9.3 foundation with
  opt-in automatic download and install-on-quit; and
- development/ad-hoc builds contain no Sparkle framework and perform no updater
  networking.

This is not a public-release verdict. The reviewed source is pushed to the
private GitHub remote, but no first-party source license exists, Cloudflare
staging is blocked and collection remains unauthorized, and no
Developer-ID-signed/notarized app, live appcast, public download, or clean-Mac
update has been produced.

## Product boundary

| Surface | Current responsibility | Explicit boundary |
| --- | --- | --- |
| Native macOS app | First-run disclosure, local source selection, loopback companion lifecycle, diagnostics, update controls, and app-open link | Foreground only; no daemon, Login Item, LaunchAgent, or orphan companion |
| Private loopback dashboard | Personal analysis, local results, contribution review, contribution receipt/status, and optional delayed community comparison | Raw Codex content and source paths are not served to the browser |
| Hosted website | Acquisition, verified download metadata, documentation, and delayed public aggregates | A webpage cannot read local Codex files or replace the personal dashboard |
| Cloudflare Worker | Disabled-first contribution service, private calculations, delayed aggregate publication, retention, and deletion | No public deployment or authorized participant collection |
| Contained Cloud Run/GCS experiment | Collection-disabled liveness, private-object readiness, and IAM/deployment research | No participant metadata store or ingest API; not the pilot backend |

The shared dashboard source can render the appropriate hosted or loopback
state, but authority does not move with the HTML. Local collection stays in the
installed app and loopback companion.

## Personal analysis experience

The current consumer copy is supported by July 29 observations on this Mac:

- a useful headline appeared in **2.180–25 seconds**;
- a cached complete pass took **110.099 seconds** across 680 selected files and
  681,587 content-free records; and
- one larger uncached run produced a useful headline in about 20 seconds and
  completed in about **5 minutes 27 seconds**.

These are observations, not a cross-machine latency promise. The durable
product statement is: useful headline results can arrive in seconds, a first
deep pass can take a few minutes, and cached or incremental passes are normally
faster. Analysis remains bounded, cancellable, checkpointed, and resumable.

### Packaged clean-state and browser QA

The built `.release-build/macos/Usage Monitor.app` companion was run from the
bundle against isolated clean app state and the real local Codex source:

- a useful headline appeared while the bounded scan was still running;
- all **714 files** completed without error, followed by completed deep
  synthesis;
- the rendered result showed 49% seven-day remaining, a replay-safe seven-day
  API-price equivalent of $7,480.36, a latest matched 5.0/5.0 percentage-point
  observed/cost-implied movement, and the historical $1,832 weekly center with
  a $1,395–$2,170 80% range across 17 qualifying fits;
- Hour/Day/Week and 24h/7d/31d changed only the headline timeline, while
  15m/1h/3h changed only advanced calibration; weekly time/evidence filters
  changed qualifying fits from 7 to 17 without cross-driving those controls;
- `America/New_York` was shown, the post-results contribution CTA and
  disclosure rendered, and the local-only build correctly reported its hosted
  service disabled;
- browser inspection found only loopback resources and no warnings or errors;
  and
- same-state relaunch restored results immediately, published a fresh headline
  in about **21 seconds**, and completed the cached refresh in about **2
  minutes 1 second to 2 minutes 31 seconds**.

The temporary isolated QA state was moved to Trash. The exact native window is
still a human-observation gate because the Mac was locked during this final
pass; the native GUI had previously reached first-run disclosure and terminated
cleanly. The browser/companion evidence does not substitute for future
quarantine-preserving clean-Mac Gatekeeper and update rehearsal.

### Scale boundary and next optimization

Quota-only refreshes now reuse a current replay-safe accounting cache while the
fresh provider quota observation continues to come from the collector ledger.
A genuinely new rollout usage record still rebuilds accounting through one
bounded **31-day** replay-safe scan.

The accounting builder enforces a measured **1.5 GiB RSS ceiling**, checking
actual process RSS as compact transition inputs accumulate. The same replay
also receives the existing export resource guard for source-file count and
bytes, directory entries, elapsed time, and line size. Any violation maps to
fixed `refresh_resource_limited`, preserves the previous owner-only cache, and
leaves the useful headline or prior dashboard visible with an explicit
safety-limit explanation. Post-audit regression coverage includes transition-
phase `accounting_transition_rss_limit_exceeded`, so that path no longer falls
through to generic failure copy.

These bounds make the current pathway appropriate for the pilot. They are not
a hidden scale-completion claim: a future persistent incremental accounting
index should avoid full-window replay whenever new usage arrives and provide
fast complete scans for very large local histories. That optimization is no
longer a safe-pilot blocker.

The browser permits the initial pass plus exactly **two** automatic bounded
continuations. Each accepted pass receives a six-minute polling window around
the server's five-minute pass ceiling, so one click has a finite roughly
18-minute UI budget. If work remains, the dashboard says **Deep analysis
paused after two bounded continuations**, retains the useful headline and
verified state, and allows an explicit later resume. The observed 714-file run
still completed in several minutes; the ceiling is a worst-path bound, not its
measured duration.

Passive recursive discovery is abort-aware and capped at **20,000 directory
entries** and **5,000 rollout files** per pass. Its byte ceiling covers later
files, appends, truncations, and reseeding. A resource pause preserves durable
cursors and emits fixed content-free evidence; foreground collection inherits
the same limits.

On the hosted path, export is now pull-driven and cancellation-aware with at
most one chunk produced per consumer pull. Telemetry export fetches one
participant-scoped page for every four contributions rather than querying each
contribution independently, and rolling-quota smoothing bins once and uses
prefix sums. The full Worker suite passed 89/89, while type, operator-script,
dry-deploy, and staging-safety checks also passed.

## Contribution contract

### First reviewed send

Contribution is off by default. Installation, app launch, local analysis, an
old manual upload, or an unchecked control cannot create recurring consent.
The affirmative path requires:

1. explicit consent to the current destination and privacy contract;
2. a bounded locally prepared content-free pseudonymous set;
3. exact local review;
4. an explicit first send; and
5. service acceptance of at least one upload from that exact reviewed prepared
   set.

If the first reviewed set contains additional pending or retryable jobs, it
remains the bound pending set. A recurring pass resumes that exact set before
preparing a new range, and the accepted-through watermark does not move until
every job in the set is terminally accepted.

The stored recurring-consent tuple is bound to the destination origin,
telemetry schema, field dictionary, and privacy-contract version. A change to
any of those inputs invalidates the consent rather than silently broadening it.
Same-origin relaunch coverage proves that persisted consent retains a
three-hour remainder when not yet due and schedules an overdue attempt with
zero delay.

### Six-hour while-open recurrence

After the accepted first-send gate, the app may attempt one pass every six
hours while the app remains open. It persists schedule state in owner-only app
storage, acquires a single-instance lock, applies a fixed run timeout, and
stops scheduling when consent is stale, the user pauses, configuration becomes
unavailable, or a privacy/identity failure requires attention.

Each recurring preparation is range-bounded:

- the source of truth is an owner-only accepted-through watermark bound to the
  same destination and contribution contract;
- preparation begins with a fixed **one-hour replay overlap** so the service
  can deduplicate safely;
- one prepared pass covers at most **24 hours** of evidence;
- the watermark advances only when the exact prepared set is durably
  terminally accepted or recognized as an accepted replay; and
- partial, retryable, rejected, aborted, timed-out, or otherwise ambiguous
  results do not advance it.

This avoids both gaps and a false claim that a merely attempted upload is
accepted evidence.

Settings v0.3 closes the preparation-publication crash boundary with an
owner-only write-ahead claim. Before touching the attempt-specific filesystem
paths, the controller persists one stable preparation ID and its exact
accepted-through/lookback/overlap/binding contract. A later run re-enters only
that attempt, verifies retained review, staging, or published evidence, and
does not prepare a fresh range while the claim remains. Once the prepared-set
ID is derived, it is durably attached to the claim and pending record before
publication, so maintenance protects the exact recovery target.

One run requests cooperative abort at a **five-minute** deadline and is capped
at **100 upload jobs** and **64 MiB**. Shutdown waits for active work and cleanup
to quiesce before releasing the single-instance lock. A long offline interval
catches up through successive 24-hour prepared passes. Discovery of more than
256 unresolved prepared sets fails closed for repair rather than growing
without a fixed bound.

### Safe prepared-artifact retirement

Accepted artifacts are not deleted just because they are old. Retirement
first requires every queue job in the set to be accepted, validates the
owner-only canonical roots, fixed set/review names, bounded flat contents, and
file metadata, then applies all of these bounds:

- protect the reviewed first-send evidence and every active write-ahead claim
  or pending set from automatic retirement;
- make an unprotected fully accepted set eligible when it is older than
  **seven days** or beyond the **eight** most-recent accepted sets;
- remove its artifacts before compacting its accepted queue rows;
- retire at most **sixteen** eligible sets in one pass; and
- never retire pending, retryable, in-flight, rejected, unverifiable, or
  otherwise non-terminal work.

No secure erasure is claimed. The purpose is bounded local lifecycle
management without deleting the evidence needed to explain or retry an
upload.

## Simplified ordinary UX

The results-first dashboard now leads to **Help map Codex limits** and
**Contribute and keep it current**, with a quiet **Not now** choice. The first
prepared set remains inspectable before Send.

The ordinary journey deliberately has no:

- recovery-code acknowledgement or recovery flow;
- account/security reset;
- personal server export; or
- multi-device management.

The lower-level backend still implements support and lifecycle capabilities,
and the native app retains troubleshooting-only local erase and targeted
Keychain reset under **Data & Diagnostics…**. Those are not onboarding or
contribution steps. A quiet **Hosted privacy controls** disclosure retains
complete deletion of contributed pseudonymous metadata because deletion is a
necessary participant right.

Contributions are described as privacy-minimized and pseudonymous, not
anonymous. Exact timestamps and a persistent installation capability can still
link records within the intended service boundary.

## Sparkle updater foundation

The external-distribution path pins the official Sparkle **2.9.3** framework,
archive digest, exact framework-tree digest, symlink inventory, Mach-O helper
inventory, and complete upstream notice. No CodexBar source is copied.

Development and ad-hoc builds fail closed:

- updater inputs are rejected;
- `Sparkle.framework` is absent;
- `UsageMonitorUpdaterEnabled` is false; and
- the app performs no update check or updater network request.

An external-distribution build must provide all three reviewed inputs together:
the exact pinned framework, one exact non-loopback HTTPS appcast URL, and one
canonical 32-byte Ed25519 public key. It stamps signed-feed and
verify-before-extraction requirements. Production automatic checks are
available, but automatic download and install-on-quit are **off by default**.
The user must opt in through **Version & Updates… → Automatic Updates…** and
can turn that choice off later. **Check for Updates…** remains available, and
the previous signed/notarized DMG plus release manifest remains the manual
rollback path.

The release pipeline contains inside-out signing for Sparkle's Installer XPC,
Downloader XPC with its entitlement, Autoupdate helper, Updater app, framework,
embedded runtime, native launcher, and outer app. That is a tested build
contract, not evidence of a live signed update. Its positive
external-distribution test explicitly prepares the pinned framework and runs
the complete updater configuration lane without a skip fallback. Repeated
preparation independently verifies and reuses an existing exact pinned
framework; aliases or modified framework contents fail closed.

The final development bundle built and passed clean-install validation:

```text
bundle bytes:   146017014
payload SHA256: 7f67a956ab458bf2137e2a82a361ec6bb7f22c0b1832e83f2157d079e57b6357
source SHA256:  6e50374874e4ac77915e85547b8599e1792359a96cc136452acd7d317bc7ebea
signature:      ad hoc
updater:        disabled
```

Those hashes bind this development artifact and source inventory; they are not
a Developer-ID/notarized public-release receipt.

## Source transparency and licensing

The configured remote was verified through GitHub on July 29, 2026:

```text
repository: adamallcock/app-usagemonitor
visibility: PRIVATE
default branch: main
```

The transparency boundary includes first-party source needed to build the
native app, loopback companion, dashboard, release-site artifact, and hosted
backend. It excludes raw logs, owner-only local analysis, credentials, signing
material, and generated release artifacts.

The reviewed source was committed and pushed to the private remote as
`26050e3b2ecbbb429cca4fe1ace1c08e1b1af639`. The exact staged patch was scanned
before commit with no leaks found, and a post-commit scan covered all 69
commits (about 9.33 MB) with no leaks found. Raw local evidence, credentials,
prepared exports, updater/signing material, and generated app bundles remain
ignored. The development app's source inventory and payload hashes above bind
the locally validated artifact; a distributable production binary still
requires the signed/notarized release path and a final artifact-to-commit
receipt.

There is no first-party `LICENSE`, `LICENSE.*`, `COPYING`, or `COPYING.*` file
in the repository. The included
[Sparkle notice](../../third_party_licenses/sparkle-2.9.3.txt) covers that
dependency, not Usage Monitor's first-party source. Public source visibility is
therefore blocked on an explicit first-party license decision; publishing the
repository without one would make the source visible, not open source.

## Platform order

Apple-silicon macOS is the primary pilot target. The public release builder
accepts only `arm64` for this pilot and rejects Intel-only or universal claims.
Intel macOS, Windows, and Linux packages remain secondary until the signed,
hosted Apple-silicon journey has passed real download, Gatekeeper, onboarding,
contribution, update, rollback, and uninstall observation. No menu-bar
controller is included in this foundation.

## Closed post-audit regression gates

A focused lifecycle audit after the first integrated pass identified three
gates for the bounded-recurring claim:

1. a crash or timeout after prepared-set publication but before controller
   persistence must recover the exact published set rather than orphaning it;
2. native shutdown must wait for an active automatic run to quiesce before
   releasing the single-instance lock; and
3. the UI must describe the bounded `lastOutcome.code` instead of claiming
   every preparation, maintenance, timeout, or upload failure is a paused
   queue.

All three are now closed in source and focused tests:

- settings v0.3 writes a stable attempt claim before publication, re-enters the
  exact attempt, binds the prepared-set ID into retirement protection, and
  covers maintenance between incomplete publication and recovery;
- shutdown aborts and waits for active work before the lock is released, with
  concurrent-restart and post-release restart assertions; and
- `publication_incomplete` is accepted by the closed client contract while the
  UI renders bounded reason-specific outcome copy.

The post-fix focused matrix passed **117/117**, and an independent recurrence
re-audit returned no actionable defects. The final integrated product matrix
below supersedes the earlier pre-audit baseline.

A separate plan-completeness repair also passed its focused matrices:
**87/87** for the combined server/web path, **8/8** for release-site behavior,
and **4/4** for the explicit external-updater lane. It proves the arm64-only
public claim, shared fail-closed semantic-open stamping, relaunch scheduling,
and non-skipping Sparkle preparation described above.

## Current verification

The consumer contribution/UI and updater changes were checked with focused and
integrated repository tests. Current handoff results:

| Command or check | Result |
| --- | --- |
| `node --test --test-concurrency=1 test/automatic-contribution.test.js test/local-contribution-preparation.test.js apps/local/server.test.mjs apps/web/test/lib.test.mjs` | Post-fix PASS, 117/117; independent recurrence re-audit clean |
| `npm run product:local:test` | Final integrated PASS, 118/118 |
| `npm run product:ui:test` | Final integrated PASS, 65/65 |
| `npm run product:macos:test && npm run product:macos:test` | Repeatability PASS, 18/18 on each run; both verified and reused the exact pinned Sparkle 2.9.3 framework |
| `npm run product:release-site:test` | Final integrated PASS, 8/8 |
| Replay-safe scan/resource-limit focused tests | PASS, 42/42; fixed status and retained-headline UI included |
| Post-performance Node 26 local-refresh/replay-cache/web focused suite | PASS, 110/110; transition-phase RSS safety mapping included |
| Passive-collector bound focused tests | PASS, 43/43; abort, discovery, byte, durable-cursor, and foreground-inheritance coverage |
| `npm --prefix apps/worker run check` | PASS; 89/89 Worker tests, 67/67 operator-script tests, typecheck, dry deployments, and staging safety |
| Final focused quality audit | No actionable findings; Worker-focused 47/47 and `git diff --check` passed |
| Final performance re-audit | PASS, 31/31; Critical 0, High 0, Medium 0 |
| `npm run product:check` | Final PASS: 65 UI, 8 release-site, 118 local, 67 Worker-script, 89 Worker-runtime, 13 contained Cloud Run, and 18 macOS tests, plus type, configuration, and dry-deploy gates |
| Development bundle build and clean-install validation | PASS; 146017014 bytes, artifact/source hashes recorded above, updater disabled, ad-hoc signature |
| Packaged clean-state/browser QA | PASS for bundled companion, 714-file analysis, deep synthesis, isolated controls, loopback-only resources, error-free browser console, and same-state relaunch; exact final native-window observation remains human-gated |
| Current-source R7 regeneration | PASS; 10/10 validated receipts across exact Node 24.14.0 and Node 26.2.0, 152 source files, source-evidence SHA256 `2dd4aeacbc6b97e8fc91561694edd96936f83b6415d332e065938c7ae7998ae7` |
| Exact Node 26.2.0 full qualification | PASS; 1,096/1,096 passed, 0 failed, 0 skipped, 0 cancelled in 165109.111292 ms |
| Bundled Node 24 full qualification | PASS; 1,080/1,094 passed, 0 failed, 14 skipped, 0 cancelled in 105090.930292 ms; skips are the explicit runtime-specific pinned-Node-26 builder/regeneration cases |
| `npm run product:staging:ready` | Expected fail-closed exit; `state: blocked`, `collectionAuthorized: false`, blockers `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED` and `R2_NOT_ENABLED` |
| Private GitHub visibility | Verified `PRIVATE` |
| First-party license inventory | No matching license file |
| Documentation relative-link and diff hygiene | PASS; all 61 relative targets exist, no trailing whitespace, and the tracked scoped diff passes `git diff --check` |

The earlier
[current-source qualification receipt](../qa/2026-07-29-current-source-qualification-receipt.md)
and [browser QA receipt](../qa/2026-07-29-current-source-browser-qa-receipt.md)
remain evidence for the local-analysis timing, bounded analysis, disposable
backend, and earlier release foundation. Their source fingerprint predates the
consumer-contribution and updater delta, so their full-suite totals are not
misrepresented as qualification of the final working tree.

The earlier interrupted R7 generation was recovered before source freeze. The
final regeneration then validated and atomically installed all ten receipts
across exact Node 24.14.0 and Node 26.2.0. Its 152-file source-evidence
fingerprint is
`2dd4aeacbc6b97e8fc91561694edd96936f83b6415d332e065938c7ae7998ae7`.
That R7 evidence scope is distinct from the packaged development bundle's
source-inventory hash recorded above.

## Final disposable local-backend acceptance

At **2026-07-29T23:05:24Z**, the real local backend acceptance completed against
isolated disposable state:

- 1,360 usage records plus 1,430 quota records were prepared into 14 batches;
- 20 isolated participants each accepted 200 records;
- all ten acceptance checks returned true;
- final active participants, contributions, accepted records, and R2 objects
  were all zero after cleanup; and
- the receipt contained no raw logs, paths, credentials, account or participant
  identifiers, or external network activity.

This closes the current source's real local encrypted-ingest/lifecycle smoke.
It does not authorize or substitute for the still-blocked remote Cloudflare
staging deployment.

## Exact cloud state and human blockers

The fresh read-only Cloudflare probe returned:

```text
schemaVersion: usage-monitor-staging-readiness-v0.1
environment: staging
state: blocked
collectionAuthorized: false
authenticated: true
d1ServiceReachable: true
resourceIdentifiersConfigured: false
r2ServiceReachable: false
blockers:
  - STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED
  - R2_NOT_ENABLED
```

Because those two early blockers remain, the probe cannot yet verify that the
named D1 resources and R2 bucket exist, the two envelope secrets are installed,
both migration streams are current, the pilot schema is present, or the
collection-control singleton is fully contained. False values for those
downstream checks are unverified prerequisites, not evidence that a remote
resource was inspected and found corrupt.

An authorized owner must:

1. enable Cloudflare R2 and accept any associated terms or billing;
2. create the two production-shaped D1 databases and one private R2 quarantine
   bucket;
3. replace the sentinel D1 identifiers in the staging environment;
4. install `ENVELOPE_PRIVATE_JWK` and `ENVELOPE_PUBLIC_JWK`;
5. apply both remote migration streams;
6. verify the bounded-admission, quarantine-reconciliation, lifecycle, and
   fully contained collection-control schema;
7. approve the stable production service/domain origin and routing;
8. authorize the disabled-first staging deployment and run the staged HTTPS
   contribution/deletion journey; and
9. separately authorize invitation issuance, collection activation, and any
   real participant.

The contained Cloud Run/GCS experiment is not a shortcut around those gates.
Its checked-in template still contains exactly three resource placeholders:
runtime service account, immutable container image digest, and private bucket.
It additionally needs an authorized Google Cloud project, API/billing
acceptance, private bucket and readiness marker, scoped workload identity,
rendered configuration, direct and effective IAM review, and deployment
authorization. Even then, it remains collection-disabled until a metadata
store implements the existing isolation, deduplication, deletion, restore, and
aggregate contracts.

## Other human-only release gates

No repository-only action can safely complete these:

1. choose the first-party source license and approve the private-to-public
   source policy;
2. approve final privacy, consent, support, update, incident, retention,
   jurisdiction, and invitation text;
3. approve final icon/social artwork and distribution provenance;
4. supply a valid Apple Developer Program team, Developer ID Application
   identity, and Keychain-backed notarization profile;
5. create and protect the Sparkle Ed25519 private update-signing key outside
   the repository and hosting environment;
6. approve and publish stable HTTPS appcast, download, website, service,
   privacy, security, support, and release-notes URLs;
7. sign the appcast and archive, Developer-ID-sign and notarize the app/DMG,
   and staple and Gatekeeper-assess both;
8. run quarantine-preserving clean-Mac installation plus update-from-previous,
   rollback, contribution, deletion, and uninstall rehearsals;
9. approve cloud backup and deletion-tombstone horizons, stopped-service
   restore, R2 reconciliation/deletion retry, alerts, incident ownership,
   support ownership, and spend limits;
10. bind the production release artifact to the reviewed source commit and
    authorize publication; and
11. explicitly authorize the first real invitation and participant collection.

## Deliberately unsupported or unproven

- No public website, source repository, installer, appcast, or collection
  service is live from this work.
- No real participant contribution or public aggregate was authorized.
- No live Sparkle update, Developer ID signature, notarization, or clean-Mac
  update/rollback was performed.
- No Intel Mac, Windows, or Linux installer is claimed.
- No menu-bar app, daemon, Login Item, LaunchAgent, silent background upload,
  email identity, or push-notification identity is included.
- No claim is made that API-price-equivalent dollars are a subscription bill
  or provider-published allowance.

## Evidence map

- Consumer/product plan:
  [contribution and updater product plan](../plans/2026-07-29-contribution-and-updater-product-plan.md)
- Local app boundary:
  [local companion guide](../../apps/local/README.md)
- Recurring controller:
  [`src/automatic-contribution.js`](../../src/automatic-contribution.js)
- Native app and updater controls:
  [`apps/macos/UsageMonitorApp.swift`](../../apps/macos/UsageMonitorApp.swift)
- Updater integrity/configuration:
  [`scripts/macos-updater-core.js`](../../scripts/macos-updater-core.js)
- Signed replacement/release contract:
  [`scripts/macos-release-core.js`](../../scripts/macos-release-core.js)
- Cloudflare readiness gate:
  [`apps/worker/scripts/staging-readiness-lib.mjs`](../../apps/worker/scripts/staging-readiness-lib.mjs)
- Contained Cloud Run boundary:
  [Cloud Run runbook](../../apps/cloud-run/README.md)

The earlier
[end-to-end pilot readiness report](./2026-07-29-end-to-end-pilot-readiness-report.md)
is retained as a historical snapshot and is explicitly superseded by this
report.
