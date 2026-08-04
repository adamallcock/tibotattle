---
title: End-to-End Usage Monitor Pilot Readiness Report (Superseded)
date: 2026-07-29
type: verification-report
status: superseded
superseded_by: 2026-07-29-consumer-contribution-and-updater-verification-report.md
---

# End-to-End Usage Monitor Pilot Readiness Report (Superseded)

> Historical snapshot. This report records the earlier manual-contribution,
> recovery-first, and manual-update development boundary. It is superseded by
> the
> [consumer contribution and updater verification report](./2026-07-29-consumer-contribution-and-updater-verification-report.md),
> which reflects the current accepted-first-send recurring contribution
> contract, simplified ordinary UX, and Sparkle 2.9.3 release foundation. Do
> not use this file as the current product verdict.

## Verdict

Usage Monitor has reached a locally executable, privacy-first pilot candidate
validated across a foreground-only macOS development artifact and separate
disposable loopback backends. A new user can be directed from an
artifact-bound acquisition build into the app, review a one-time local-data
disclosure, open a private loopback dashboard, analyze Codex metadata without
selecting raw logs, obtain a useful checkpoint before deep accounting
finishes, and cancel or resume bounded work.

It is not yet one publicly distributable end-to-end pilot. The current
ad-hoc-signed DMG has no central service configured; its release URLs are
non-published smoke inputs. Optional contribution, recovery, private results,
export, and deletion were proven through a separately loopback-configured
development journey, not through this local-only DMG. External distribution,
remote staging, and real-user collection remain deliberately disabled until
the human gates in this report are satisfied.

## Consumer journey and acceptance evidence

| Journey stage | Implemented behavior | Verification state |
| --- | --- | --- |
| Discover and download | Static release-site build with explicit installer metadata, platform compatibility, privacy/support/release links, canonical and crawler metadata, and no claim that a webpage can read Codex logs | Seven-file artifact-bound build, contract tests, a rendered baseline, and the source-qualified/rebuilt final recovery delta passed; destination availability and publication remain human gates |
| Open the app | The ad-hoc-signed development app accepts only the semantic open target (`usagemonitor://open`, case-insensitive, with an optional root slash) and rejects non-root paths, queries, fragments, credentials, ports, alternate schemes, and alternate hosts | Compiled smoke passed |
| First run | One-time Get Started disclosure precedes companion startup and states what is read, retained, excluded, and never automatically uploaded | Compiled owner-only persistence and unsafe-mode rejection passed |
| Local setup | Default or native-selected custom Codex home, missing/no-task/unreadable/writable-state guidance, Retry, Open Codex, and path-free diagnostics | Native and loopback tests passed |
| Useful first result | Separate bounded checkpoint pass publishes current quota and recent cost evidence before 7-day/31-day work | The rendered-baseline disposable run exposed a useful result within a 25-second observed upper bound; a cached continuation produced its exact quick result in 2.180 seconds; the final delta does not touch analysis |
| Deep analysis | Automatic bounded continuation, progress, honest time guidance, cancellation, timeout, resume, source-consistency checks, and last-good cache reuse | Local suite passed |
| Results | Results-first overview, cost/allowance timeline, measured-versus-calculated calibration, weekly allowance history, uncertainty, model/speed/surface/tool accounting, and coverage explanations | 57 current UI contracts plus rendered-browser QA passed |
| Optional contribution | Invite, consent, recovery-first enrollment, upload-only device pairing, stale-device recovery, remaining-admission preflight, local preparation, exact review, explicit Send, receipt, and private result | The rendered loopback lifecycle passed with an isolated in-memory device-credential backend; final source additionally preserves a fixed stale-credential recovery state and routes both pairing paths to the existing native two-confirmation reset without automatic mutation; the current DMG is central-service-unconfigured |
| Return use | Cached results load immediately and one bounded incremental refresh follows | Source-bound rendered-browser and contract checks passed for local-only return use; the final delta does not touch refresh behavior |
| Participant rights | Recovery, security reset, participant export, verified deletion, device revocation, and content-free lifecycle history | The browser pass rendered sign-out/recovery/rotation, export request, single-batch deletion, participant deletion, maintenance, and readiness recovery; targeted native reset and device revocation are separately compiled/contract-tested rather than claimed as performed against the real Keychain/service; remote staging remains unprovisioned |
| Update and uninstall | No updater or background download; discoverable version/manual signed-DMG replacement, rollback, app-state erase, targeted Keychain reset, hosted deletion, and uninstall help | Eleven compiled/static contracts passed; signed/notarized replacement, rollback, erase, Keychain reset, and uninstall still require clean-Mac rehearsal |

## What a completely new user does

The intended pilot journey is deliberately short and does not require Terminal:

1. **Open the public page.** The page explains that a normal website cannot
   read Codex files. It shows the exact app version, supported Mac, download
   size, SHA-256, privacy, security, support, and release-notes links.
2. **Press “Download Usage Monitor for Mac.”** The current development artifact
   is a 44 MiB Apple-silicon DMG. A public download does not exist until the
   human release gates are complete.
3. **Open the DMG, place Usage Monitor in Applications, and launch it.** The
   development artifact is ad-hoc signed and suitable only for local
   verification. The public artifact must be Developer-ID-signed, notarized,
   stapled, and checked on a clean Mac.
4. **Read the one-time disclosure and press “Get Started.”** Before any
   companion starts, the app says what it reads, what remains local, what is
   excluded, that nothing is uploaded automatically, and what happens if the
   app or browser is closed.
5. **Wait for “Ready,” then press “Open Dashboard.”** The app opens a loopback
   browser tab. If Codex is absent, empty, unreadable, or stored in a custom
   location, this same screen provides the next action rather than a raw
   filesystem error.
6. **Read the first result.** Cached results appear immediately on a return
   visit. The rendered-baseline disposable run visibly produced a useful quota/cost
   checkpoint within 25 seconds. A later cached continuation recorded an exact
   2.180-second quick result and a 110.099-second complete bounded pass across
   680 selected files. Each pass checkpoints, can be cancelled and resumed,
   and preserves the last valid result. These are single-machine
   observations, not a general latency promise.
7. **Explore Overview, Trends, and Weekly.** The main chart uses cost on one
   axis and allowance remaining on the other, browser-local time, 24-hour,
   7-day, and 31-day ranges, hourly/daily/weekly grouping, and explicit
   uncertainty. Advanced calibration is collapsed by default.
8. **Optionally contribute after a production service origin is configured and
   deployed.** The user enters an invitation, accepts consent, saves the
   anonymous recovery code, connects the Mac, chooses a bounded lookback,
   prepares locally, reviews the exact content-free fields, and presses Send.
   Preparation alone performs no upload. This step is unavailable in the
   current local-only DMG.
9. **Return or leave.** Local results remain available without a hosted
   service. After a production service origin is configured and deployed,
   there is no email or push identity: the user returns with the recovery code
   and explicitly refreshes private results. Closing the browser is always
   safe; closing the app stops local work after its last durable checkpoint.
10. **Update, erase, or uninstall.** “Version & Uninstall…” explains manual
    signed-DMG replacement and rollback, local app-state deletion, the two
    exact Keychain items, hosted deletion, and removal from Applications.

## Privacy and authority boundary

- The native companion reads local Codex source material; the public website
  does not.
- Prompts, responses, repositories, file paths, commands, arguments,
  credentials, emails, account names, and raw source records do not enter the
  browser or contribution contract.
- Browser-visible and hosted records contain only the closed content-free
  metadata schema required for accounting and quota triangulation.
- Optional contribution is off by default and requires separate preparation,
  exact review, consent, and Send actions.
- The pilot collects no email or push-notification identity. A participant
  returns with the saved anonymous recovery code and explicitly refreshes
  private results.
- Local app state, two targeted Keychain capabilities, and hosted participant
  data are separate lifecycle layers. No one deletion action claims to erase
  the other layers or to provide secure erasure.
- No external deployment, cloud mutation, notarization submission, publication,
  or real-user collection was performed during this work.

## Hosted-service readiness

The Cloudflare Worker implements closed-schema validation, encrypted
quarantine, D1 ingestion, idempotent deduplication, participant isolation,
admission limits, private results, delayed thresholded community publication,
recovery, export, deletion, retention, restore replay, and reconciliation after
interruption.

The contained Cloud Run/GCS package is a future, collection-disabled
deployment/storage experiment. It is limited to liveness, readiness,
conditional object operations, shutdown, configuration, and IAM gates; it
refuses every `/api/*` request and is not an alternative pilot backend.

Remote pilot operations are separate from application traffic. Invitation
issue/resume/revoke and pilot activate/pause/resume/rollback commands use
operator-held capabilities outside argv and logs, optimistic control
revisions, bounded receipts, exact-resource preflight, and fail-closed
rollback. Checked-in staging remains disabled and community publication remains
off during invite-only activation.

No remote mutation or deployment ran during this work. The checked-in
configuration gate is `safe_unprovisioned`, `collectionAuthorized: false`, and
blocked by `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED`. The read-only live
probe authenticated and reached D1, but returned `state: blocked` with
`STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED` and `R2_NOT_ENABLED`; the named
D1/R2 resources, installed secrets, migrations, pilot schema, and runtime
containment therefore remain unverified. The operational runbook remains
blocked on real resources, secrets, domain control, billing, and deployment
authorization.

## Release artifacts

The development build is Apple-silicon-only, foreground-only, contains its
pinned Node runtime and closed dependency graph, starts no daemon or login
item, and is ad-hoc signed for local verification. Its manifest records no
central service, production origin, approved icon or provenance, Developer ID,
or notarization configuration. The production release pipeline requires those
inputs, a monotonic bundle version, hardened runtime, Apple notarization,
stapling, Gatekeeper assessment, and clean-profile smoke before it can produce
a publishable DMG and release manifest.

The app payload is reproducible under the pinned builder. The DMG has a
deterministic logical layout, but Apple's disk-image tooling assigns fresh
filesystem/image metadata, so byte-for-byte DMG reproducibility is not claimed;
each produced image is instead hashed and bound into the release-site manifest.

The final development build produced:

- app payload SHA-256:
  `38ff6b66b80704e3744ae43b05a9835fcfe86bc6c1bea00afd7b5ee106dd1b03`;
- app source SHA-256:
  `408f6a54cac79d5a5b186733347fee17701baf96f15bfc7d1f6ba3749829516b`;
- DMG bytes: **45,657,009**; and
- DMG SHA-256:
  `2a6ab3796e773bf71e60fa6a6f2e17bd27613784885b5674b0e171be80f75e0c`.

The public-site smoke bound that exact DMG to a seven-file site manifest,
verified a 1200×630 PNG, and populated canonical, Open Graph, Twitter,
compatibility, support, security, privacy, release, and crawler metadata. The
final manifest SHA-256 is
`e082586cfffad3074dcb55b85513ca0d4dca514e0540c580f3e3ac5ae92db050`.
The
smoke URLs and preview artwork are non-published test inputs, not approved
public destinations or release artwork.

## Validation

The
[current-source qualification receipt](../qa/2026-07-29-current-source-qualification-receipt.md)
binds the dual-runtime and integrated product results below to 418
implementation files, 7,143,958 bytes, and implementation-set SHA-256
`64304c8f2cf7edb087a185780ce72b71094e7863a78e3fa5bab65c6018b19d0f`.
The checkout was deliberately dirty; the fingerprint includes tracked and
untracked non-ignored implementation files and excludes dated receipts and
ignored build artifacts.

A checksum-verified Gitleaks 8.30.1 `--redact=100`
secret-field-redacted scan covered the complete Git history and a separate
copy of all 418 qualified source files. Nine
historical and seven current generic-key detections were reviewed as fixed test
fixtures or prose; no actionable credential finding remained. The scanner,
reports, and copied source stayed in an owner-only temporary directory outside
the repository and were moved recoverably to Trash after review.

### Fresh results already obtained

- Local product: **103 passed, 0 failed, 0 skipped**.
- macOS product: **11 passed, 0 failed, 0 skipped** in the final integrated
  rerun; Swift typechecking, app launch/watchdog, central-relay, and the
  post-audit first-run guard all passed.
- R7 regeneration/publisher recovery: **14 passed, 0 failed, 0 skipped**.
- UI: **57 passed, 0 failed, 0 skipped**.
- Public release site: **6 passed, 0 failed, 0 skipped**.
- Worker operator scripts: **67 passed, 0 failed, 0 skipped**.
- Worker runtime: **86 passed, 0 failed, 0 skipped**, with current types,
  typecheck, dry deploy, and fail-closed staging checks.
- Contained Cloud Run/GCS implementation: **12 passed, 0 failed, 0 skipped**,
  with its collection mode disabled and three resource placeholders intact.
- Node 24.14.0 repository suite: **1,040 tests; 1,026 passed, 14 skipped,
  0 failed**. The 14 skips are the macOS Node-26-builder and Node-26-only
  regeneration/recovery cases; telemetry contract: **11/11**.
- Node 26.2.0 repository suite: **1,042 passed, 0 skipped, 0 failed**;
  telemetry contract: **11/11**.
- Dual-runtime retained R7 evidence validation: **2/2 under each runtime**.
  Exactly ten mode-0600 receipts were regenerated from 151 frozen workload
  files with source SHA-256
  `0453b0e44c8782326dae92a5ac5731585f03e933bc0e3f3987316f79487d7464`.
  Both decisions remain `release_open`, not `release_ready`: privacy and
  preservation passed, while ceiling selection, determinism, engineering
  rounding, exact runtime pairs, input outcomes, lifecycle operations, and
  network isolation remain open.
- R7 decision JSON SHA-256 values: Node 24
  `836ce6247062655a1fd3e07d35fbaaded5590f83716516f83bcea7a23047c048`;
  Node 26
  `ce3b304fe5408249db7e939d1acbc79787b4e94491628fa6b5ff350b0195b3d3`.
  Their embedded `receiptSha256` provenance values are respectively
  `2f39fb04da6cabc10d35f9c7073c00b4f59d686552df9236d29e55daa6b160f8`
  and
  `09544eb23c75b389776d8e5627392af65d2dcae059f11454474c53a91fba1d76`.

### Rendered browser baseline and final recovery delta

The [browser QA receipt](../qa/2026-07-29-current-source-browser-qa-receipt.md)
records contemporaneous exact hashes for the rendered public/local baseline,
whose replaced bytes were not retained as a replayable second source tree. It
separately binds the retained final recovery harness, final source, and rebuilt
DMG/site hashes. The rendered baseline verified the install/open-app
boundary, absent and empty Codex guidance, real local results, browser-local
time, cost and percentage axes, weekly estimate, independent
usage/calibration filters, useful-result timing, fresh contribution, recovery
rotation, export request, single and full deletion, scheduled maintenance,
readiness recovery, and empty browser dev logs. The final recovery delta was
source-reviewed, passed 78 focused tests, both integrated local/UI gates, both
full runtime suites, and an injected conflict test proving zero credential
creates, deletes, or network calls across two retries. Its exact current
renderer and stylesheet were also executed in a disposable native WebKit
harness with runtime DOM assertions and a mode-`0600` visual receipt. This
remains local-development evidence, not a public-host or clean-Mac receipt.

The rendered-baseline Analyze action was recorded at
`2026-07-29T11:31:41.177Z`; useful quota and recent-cost evidence was visible
when checked no later than 25 seconds afterward. The exact cached continuation
ran from `2026-07-29T11:38:05.222Z` to
`2026-07-29T11:39:55.321Z`, with its quick result at
`2026-07-29T11:38:07.402Z`. It discovered 2,964 files, selected and processed
680, and retained 681,587 content-free records. The cached timing qualifies
return-use behavior and must not be presented as a clean-install result.

### Unreceipted observed real-local run

The observed real-local refresh discovered 2,933 rollout files, selected 668
within the bounded recent-history plan, and retained **697,698** content-free
records with no malformed lines. It produced a useful initial headline in
approximately 20 seconds and completed the full bounded continuation in
approximately 5 minutes 27 seconds. The resulting local API reported live
evidence with:

- **$7,149.70** of seven-day API-price-equivalent activity;
- **79,870** replay-safe usage increments and **10.99 billion** recorded
  tokens;
- **100%** seven-day API-pricing coverage;
- two quota tracks observed during that run, with the primary track at **83%**
  remaining during the verification run; and
- a historical median seven-day allowance estimate of **$1,832 API
  equivalent**, an across-reset central-80 range of **$1,395–$2,170**, and
  **17** qualifying reset-series fits.

These values were observed during this work but were not published into a
source-plan-bound standalone timing receipt. They are retained as operational
context, not release qualification. They are local measurements, not a
subscription bill or provider-confirmed dollar cap. The optional contribution
path prepared 21 batches with approximately 4,200 safe records and 4.4 MB of
content-free data; preparation performed no upload.

### Disposable hosted lifecycle receipt

The [real-data backend receipt](../receipts/2026-07-26-consumer-backend-real-data-verification-receipt.md)
binds one selected 200-record contribution—99 usage events and 101 quota
observations—to the complete disposable Worker/D1/R2 lifecycle. It proved
server repricing, private results, aggregation, recovery, export, contribution
deletion, participant deletion, and zero active participants, contributions,
canonical records, retained quarantine references, sessions, devices, or live
R2 objects after destructive cleanup.

The separate [inspectable laboratory receipt](../receipts/2026-07-26-inspectable-backend-laboratory-verification-receipt.md)
binds a generated-fixture run with 20 participants, 20 encrypted
contributions, 40 canonical records, 40 contribution-occurrence rows,
privacy-canary rejection, idempotent replay, restart persistence, community
publication, recovery, and private results. Later destructive smoke left zero
live participant data and 20 digest-only deletion tombstones. These are durable
local-development receipts; the current staging environment remains
unprovisioned.

The rendered browser pass added a fresh participant to the verified
20-participant fixture, prepared seven one-hour batches with about 1,300 safe
records, reviewed and sent one 80-record batch, observed 38 usage events,
42 quota snapshots, `$4.02` server-repriced API equivalent, and 100% pricing
coverage, then exercised export, sign-out, recovery-code rotation,
single-batch deletion, and participant deletion. Scheduled maintenance
completed retention, restore replay, quarantine reconciliation, and aggregate
rebuild before readiness returned to HTTP 200. The database returned to the
20-participant fixture baseline with one digest-only tombstone for the
disposable participant.

The temporary companion used an injected in-memory contribution-device
credential backend so the browser pass could not overwrite or delete an
existing Keychain capability. Final packaged source now detects the
pre-existing-Keychain/missing-binding conflict, emits only
`contribution_device_recovery_required`, and routes both pairing paths to
**Data & Diagnostics… → Identity & Device Reset…** with both native
confirmations. That closes the former retry loop. Actual execution of the
packaged reset on a signed clean Mac remains a human rehearsal, not a claim
from the rendered pass.

## Human-only gates

No remaining gate below can be satisfied safely from this repository alone:

1. Approve final privacy/consent/support/release text, pilot jurisdictions,
   invitation policy, retention statement, and the decision to collect real
   participant data.
2. Supply approved production domain/origin control and authorize public-site
   publication.
3. Enable and provision paid Cloudflare D1/R2 resources, billing, production
   secrets, operator capabilities, and domain routing; then authorize staging
   and production deployment. The Cloud Run/GCS experiment is not an
   alternative pilot backend.
4. Supply approved app artwork and provenance if the final asset is not yet
   accepted.
5. Supply a valid Developer ID Application identity and Keychain-backed
   notarization profile, then authorize Apple submission.
6. Run the final signed and notarized DMG through the documented Gatekeeper and
   first-run journey on an unlocked clean Apple-silicon Mac.
7. Authorize creation/publication of the real release URL, GitHub release, and
   public 1200×630 social-preview asset.
8. Issue the first real invitation only after readiness is green and an
   operator is available to pause or roll back the pilot.
9. Approve the backup and deletion-tombstone horizon, then perform stopped-
   service restore rehearsal for both D1 databases and R2 reconciliation plus
   deletion-retry rehearsal.
10. Configure and exercise operational alerts, spend/billing limits, incident
    ownership, named invitation/support ownership, and recovery/re-pairing
    support copy.
11. Complete the staged HTTPS contribution, recovery, export, and deletion
    journey in the supported browsers before accepting a participant.
12. Provide a second bounded Apple-silicon machine-class R7 measurement and
    approve the engineering rounding and ceiling-selection policy. The current
    privacy-preserving receipts intentionally leave paired-machine identity
    absent, so any change to that policy also requires explicit approval.

## Deliberately unsupported in this pilot

- Intel Macs, Windows, and Linux consumer installers.
- Automatic updates, silent downloads, login items, daemons, or background
  uploads.
- Email or remote push notifications and the identity collection they require.
  This does not describe the later native macOS local-only allowance alert:
  that opt-in feature has no email/push identity, no daemon, and evaluates only
  fresh direct provider evidence while the app's existing foreground refresh
  runs.
- Automatic public community publication below its privacy threshold.
- Claude collection in the consumer pilot.
- Ordinary ChatGPT chat, Chat Voice, Excel, and other surfaces are not
  collected or attributed by this pilot; no claim is made here about their
  provider-side quota-pool accounting.
- Claims that API-equivalent dollars are a subscription bill or that the
  inferred weekly allowance is provider-confirmed.

## Exact final local commands

The source-bound R7 regeneration used:

```bash
$HOME/.nvm/versions/node/v26.2.0/bin/node \
  scripts/regenerate-r7-release-evidence.js \
  --node24 $HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --node26 $HOME/.nvm/versions/node/v26.2.0/bin/node \
  --start-at 2026-06-24T09:00:00.000Z \
  --end-at 2026-07-25T09:00:00.000Z \
  --destination $HOME/Documents/Coding/app-usagemonitor/generated \
  --replace
```

Qualification then used:

```bash
$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test test/r7-generated-release-evidence.test.js
$HOME/.nvm/versions/node/v26.2.0/bin/node \
  --test test/r7-generated-release-evidence.test.js

PATH=$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test
PATH=$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run telemetry:check
PATH=$HOME/.nvm/versions/node/v26.2.0/bin:$PATH npm test
PATH=$HOME/.nvm/versions/node/v26.2.0/bin:$PATH npm run telemetry:check
PATH=$HOME/.nvm/versions/node/v26.2.0/bin:$PATH npm run product:check
```

The final development artifacts used:

```bash
npm run product:macos:build
npm run product:macos:validate:development
npm run product:macos:dmg
node ./scripts/validate-macos-install.js \
  --dmg ".release-build/macos/UsageMonitor-0.0.1-macOS-arm64.dmg" \
  --development
```

The final non-mutating staging boundary is:

```text
config state: safe_unprovisioned
live state: blocked
collectionAuthorized: false
blockers:
  - STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED
  - R2_NOT_ENABLED
```

`product:staging:prepare`, `product:staging:deploy`, remote resource creation,
Apple signing/notarization, publication, invitation issuance, and real-user
collection were not run because they require the human permissions listed
above.
