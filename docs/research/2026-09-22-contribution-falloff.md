---
title: Published 0.1.23 refresh and contribution falloff investigation
date: 2026-09-22
type: research
status: investigated
---

# Investigation boundary

Determine whether the published 0.1.23 refresh defect delays or stops uploads,
identify other causes of declining daily contributor counts, and compare source
findings with read-only production observations. Do not infer a population-wide
cause from one client defect. No production mutations, private payloads, or
participant identifiers belong in this report.

## Completed investigation

1. Pin the published release and reproduce refresh timing from its source.
2. Trace upload startup, timer, freshness prerequisites, retry and terminal states.
3. Read production health, accepted-upload history, failure aggregates and metric
   definitions; distinguish partial days, upload arrivals and activity dates.
4. Rank causes, document synthetic validation and prioritize remediation with
   remaining proof gaps explicit.

## Source and live identities

- Investigation checkout: `9385bad260698814cc2a4a6c685575a3fd63811a`.
- Published release: `v0.1.23`, GitHub target
  `dd4ca80510ddf0834baa55294ce1b2487cd473b7`, published
  `2026-09-14T16:12:59Z`.
- Live `/api/health` on September 22 reports source
  `c93a5a513890be5d4db97de5bcc9a684cbb91f18` and operational enrollment,
  upload registration, processing and publication. This proves current health,
  not historical availability or successful uploads from every client.

## Conclusion and confidence

The refresh defect can materially reduce fresh contributed activity, including
indefinite starvation for a particular returning-user pattern. It does not
directly delay the independent upload timer based on refresh age. It is not
enough evidence to attribute the whole observed decline to version 0.1.23.

Two client defects are reproduced: rejected refresh completion and a terminal
upload pause after a transient HTML HTTP 503. Production health and aggregates
are observed live; their attribution to individual client failures remains
unproven. A separate full-history activation requirement explains why accepted
uploads are not necessarily visible as recent public activity.

## Live observations, September 22

Read-only observations came from the authenticated
[admin dashboard](https://admin.tibotattle.com/admin),
[public daily API](https://tibotattle.com/api/v1/community/daily?from=2026-08-24&to=2026-09-22)
and [health endpoint](https://tibotattle.com/api/health).
The growth snapshot was generated at approximately 12:21 UTC. The main overview
was observed around 12:59 UTC and reconstruction around 13:14 UTC. These are
different snapshots, not a transactionally consistent census.

| UTC day | Identities uploading that day, admin | Contributors with activity dated that day, public |
|---|---:|---:|
| August 24 | 6 | 17 |
| September 4 | 5 | 15 |
| September 9 | 1 | 8 |
| September 10 | 0 | 9 |
| September 11 | 2 | 8 |
| September 12 | 1 | 9 |
| September 13 | 0 | 9 |
| September 14 | 3 | 9 |
| September 15 | 7 | 8 |
| September 16 | 10 | 7 |
| September 17 | 6 | 5 |
| September 18 | 7 | 4 |
| September 19 | 5 | 4 |
| September 20 | 7 | 4 |
| September 21 | 22 | 3 |
| September 22, partial | 11 | 1 |

The public September 21 revision was published at `2026-09-22T04:12:46.212Z`;
September 22 at `2026-09-22T10:14:43.605Z`. September 18–20 revisions were
republished September 21. These are not simply unrecomputed weeks-old pages.
They can still lag newly accepted data or staged generations.

The public contributor decline is real in the published activity series, but
is not evidence that only three identities uploaded on September 21. Historical
days can gain contributors through later backfill: August 24's 17 contributors
do not mean 17 people uploaded on August 24. Both series count pseudonymous
identities, not verified unique people. Re-enrollment and multiple installations
are additional reasons not to interpret them as a human retention census.

Other observations:

- The growth snapshot reports 16 uploading identities, 3,220 chunks and 593,511
  uploaded records in its preceding 24 hours. It reports 52 identities with
  incremental uploads across retained history. September 21's enrollment chart
  shows 17 identities created; these are not proven new humans.
- The later overview reports 64 active identities and 52 with accepted data.
  The reconstruction view reports 23 active owners. These different populations
  warrant a completion-funnel check; subtraction is not a proven stalled-user
  count.
- Collection stages are operational; databases readable; ingress shows zero
  concurrency/start-rate denials and all 1,200 start tokens available. This rules
  out a current global stop or observed shared-budget saturation, not every
  endpoint-specific rate limit or historical incident.
- The allowance preview is older than 24 hours, generated September 20 at
  20:59 UTC. Reconstruction reports 219 results remaining and only nine results
  in six hours. That is a separate calculation/publication problem; a low
  allowance cohort is not a count of current uploading clients.
- The retained service-failure panel has only three sampled 5xx entries, latest
  September 18. It does not capture all failures, 401/403 responses, client-side
  validation failures, or every edge-generated response. It cannot disprove the
  terminal-pause hypothesis.
- Update analytics observes approximately 91 source addresses in 24 hours and
  195 in seven days, with sampling and predominantly unknown Electron versions.
  Addresses are not installs or people; a conversion percentage would be invalid.

## 1. Refresh completion is rejected: confirmed defect

At the released tag, renderer `apps/web/public/app.js:11801,12074` calls
`refreshSettled({ lease })`, but `apps/electron/preload.cjs:135–139,417–420`
requires the numeric lease. Rejection occurs before IPC and the renderer swallows
it. The controller therefore keeps the refresh marked in progress after the
actual work completes.

`apps/electron/desktop-controller.js:24,533–541,1372–1398` uses a 123-minute
watchdog; expiry then arms the configured five-minute timer. The reproduced
interval is **128 minutes**, consistent with the reported approximate 125.
Passing the numeric lease correctly rearms five minutes immediately.

The same mismatch exists in tags **0.1.19 through 0.1.23**. Version 0.1.19 was
published September 10; 0.1.23 on September 14. The public series already fell
from 15 on September 4 to eight on September 9. Therefore this defect cannot
explain the beginning of the entire visible decline, although it can exacerbate
later loss of fresh activity.

Existing source fixes are `6b8af2db` / PR #176 and follow-up lifecycle recovery
`4d41794a` / PR #184, present in inspected `origin/main` and release-0.1.24 refs,
absent from 0.1.23. Source integration is not published-client repair.

## 2. How stale refreshes affect uploads: indirect but serious

The accountless scheduler runs on launch, then normally every **four hours**.
Partial uploads retry after one minute; retryable failures use exponential
backoff capped at four hours, subject to bounded server Retry-After.
No refresh-age test exists in that scheduler. A successful pass containing
zero new chunks still schedules the next pass four hours later. Production does
not call its `runNow()` when a refresh completes.

Sources at 0.1.23: `src/application/accountless-contribution-scheduler.js:2,97–114,127`;
`apps/local/server.js:4150–4178` starts it after the bounded startup snapshot.

The upload runner reads the existing unified index; it does not update that
index. `src/local-companion-refresh.js:1202–1213` advances it only in a
**detailed** refresh. A quick refresh can update visible quota evidence while
leaving uploadable usage history unchanged.

Startup selects quick whenever an available, nonterminal accounting projection
exists, without an age check (`apps/web/public/app.js:12195–12200`). Automatic
detailed work has a separate persisted hourly clock
(`desktop-automatic-refresh-cadence.js:255–282`), but must wait for the broken
automatic timer to fire.

Synthetic controller/cadence results:

| Launch state | Minute 128 | Minute 256 | Minute 384 |
|---|---|---|---|
| Existing hourly cadence already due | Detailed | Detailed | Detailed |
| Missing cadence state | Quick | Detailed | Detailed |

Consequences:

- A continuously running healthy client normally gets detailed ingestion about
  every 128 minutes; initially missing cadence can defer its first automatic
  detailed pass to 256 minutes. Work duration and failures can add delay.
- The next independent upload can then be almost another four hours away.
  This is a latency explanation, not a guaranteed end-to-end bound.
- A returning user who **actually quits the app/process before 128 minutes on
  every launch** can get quick-only startup indefinitely. Available old history
  keeps startup quick, and the detailed timer never fires. This can produce
  ongoing uploads/backfill but no newly indexed activity. Hiding the window in
  the tray does not end the process and is not this scenario.
- Cadence read/reservation failures can also keep automatic mode quick.
- A newer index generation left `in_progress` blocks uploading the old
  published generation until recovery (`contribution-incremental-sync.js:416–420`).
- Restart alone can rearm uploads but does not guarantee detailed ingestion.

Startup quick and detailed-only ingestion already exist in 0.1.22. They are
not a newly introduced 0.1.23 behavior.

## 3. Transient server error permanently pauses uploads: reproduced

The accountless client validates JSON and exact `cache-control: no-store`
headers before it examines HTTP status
(`src/contribution-accountless-client.js:318–345`). HTML HTTP 503 becomes
`response_invalid`, with `retryable: false`, instead of a transient failure.
The scheduler then publishes `paused` and installs **no next timer**
(`accountless-contribution-scheduler.js:83–90,105–107`).

| Mock response | Classification | Actual scheduler result |
|---|---|---|
| JSON HTTP 503, expected headers | `service_unavailable`, retryable | Retry after 60 seconds |
| HTML HTTP 503 | `response_invalid`, nonretryable | Paused, next attempt null, no timers |

The v1.1 upload reader has a similar body-before-status path and makes some
mid-body network failures terminal (`src/contribution/telemetry-v11-sync.js:109–139,227–228`).
One transient failure can therefore strand an otherwise continuously running
client after the service recovers. Restart or an eligible preference change
rearms the scheduler. Do not automatically resume genuinely revoked credentials,
opt-outs or rejected authorization while repairing transient-error handling.

This defect is unchanged between 0.1.22 and 0.1.23 and remains in the inspected
current source. Its production incidence is unknown. The scheduler exposes only
state, next attempt and last acceptance, losing the failure code; desktop status
is memory-only. Retrospective attribution is consequently limited.

## 4. Accepted history is not yet public history

Released v1.1 upload runs oldest-first across the complete historical domain,
including empty days. Accountless calls cap a pass at **500 chunks / 60 seconds**.
Only after the complete domain succeeds does the client activate the domain.
Until then chunks can be accepted without an active generation.

Sources: `src/contribution/telemetry-v11-sync.js:467,526–531,593–653` and
`src/contribution-accountless-client.js:822–823`. Existing tests demonstrate a
62-day domain whose first pass stages 57 days without activation; a later pass
finishes and activates all 62. There is no recent-day priority in that path.

Ordinary index changes between passes preserve staged manifests but reset local
prefix validation. Changes during a pass can interrupt it; context/domain-bound
changes can discard saved progress. This creates additional work, but it is not
evidence that the slower refresh cadence itself increases revalidation churn.

The deployed source has further publication boundaries:

- Accountless public eligibility requires a current domain head on its enrolled
  device (`migrations/0060_public_contribution_sources.sql:6–40`).
- Analytics must finish the whole v1.1 domain projection before advancing its
  owner head (`v11-daily-projection.ts:381–397,427`).
- The visible daily queue is populated after that owner-head change. A displayed
  queue of zero does **not** prove no staged or projecting history remains.
- Public daily aggregation includes both v1 and v1.1 sources, choosing the active
  authority per owner (`storage-community-authority.ts:156–169`;
  `storage-community-daily.ts:89–114`). There is no found blanket v1.1 omission.
- Admin typed growth also includes both formats and counts by receipt time
  (`admin-metrics-history.ts:269–315,489–502`). Its cache rebuild is throttled to
  55 minutes and old valid snapshots can remain visible on refresh failure.

These paths explain how new enrollment/backfill can raise upload arrivals
without immediately repairing the right-hand side of the public activity graph.
The exact number held at each boundary has not been measured here.

## Other causes checked

- Credential rejection, revoked devices, an explicit opt-out or unfinished
  existing-user sharing notices stop contribution intentionally. These require
  state-specific diagnosis, not automatically enabling sharing.
- Ordinary social-device expiry is measured in days (30-day expiry/idle limits,
  180-day social recheck), with renewal on successful authentication. A
  128-minute refresh interval is not by itself an expiry explanation; accountless
  enrollment/ownership renewal also has explicit recovery paths.
- Source admission limits allow 20,000 new chunks/device/day for the first seven
  days and 2,000 afterward. A large backfill can hit this transition and wait
  until the next UTC day. These are source limits, not a measured incident count.
- [Issue #125](https://github.com/adamallcock/tibotattle/issues/125), still open
  when checked, reports a macOS 26 startup failure in 0.1.22. A process that cannot
  start cannot contribute. This is a real support signal, but neither current
  incidence nor 0.1.23 population impact is established. Preserve credentials
  when diagnosing secure startup; do not suggest clearing identity or Keychain.
- [Issue #130](https://github.com/adamallcock/tibotattle/issues/130) documented
  Windows large file IDs failing validation and leaking a collector lock.
  Release-tag inspection confirms 0.1.23 includes the exact-ID/cleanup source fix
  (`481b6ced`). This is a credible cause for affected older installations, not a
  demonstrated remaining 0.1.23 defect; no Windows native proof was run here.

## Remediation priorities and remaining proof

1. **Release the existing refresh fix after exact-artifact qualification.** Prove
   repeated automatic completion through the actual renderer/preload/controller,
   detailed index advancement and accepted uploads. A timer unit test alone
   previously missed the incompatible renderer mock.
2. **Fix transient response classification and recovery.** Treat bounded
   non-JSON 408/429/5xx and genuine interrupted response streams as retryable
   without accepting malformed success payloads or weakening authorization.
   Cover both enrollment and v1/v1.1 transport, not just the scheduler.
3. **Close the stale-index startup gap.** Use index freshness and successful
   generation evidence to decide whether detailed work is due; short sessions
   must not reset the only opportunity to advance it. Keep quick quota updates
   independently responsive.
4. **Coalesce an upload wake-up after a successful new index publication.** Keep
   bounded backoff, opt-out, authorization and single-flight guarantees. Faster
   refresh by itself does not repair the separate four-hour no-op wait.
5. **Measure the completion funnel with aggregate-only queries:** accepted
   uploaders; staged but inactive domains; active source heads; projected owner
   heads; newest observed day; published current-day contributors. Split by
   enrollment cohort and transport. Inspect repeat staging and credential
   renewal/rejection counts without exposing identifiers or payloads.
6. **Make upload failure and index freshness observable.** Preserve content-free
   failure code, last attempt/success, next retry, indexed-through time and
   activation progress locally. Fleet collection requires its own privacy
   decision; absence of telemetry is not permission to add it implicitly.

No remote writes, migrations, releases, settings changes or production canary
uploads were performed. The direct Wrangler read was unavailable without an
API token; the authenticated admin UI supplied the live aggregates instead.
Consequently no per-cohort database reconciliation, affected-client incidence
measurement or population-wide root-cause claim is justified yet.

## Validation performed

- Verified GitHub release metadata and inspected exact release-tag source;
  relevant tested preload/controller and upload modules match that tag.
- Executed synthetic actual-module reproduction: object completion argument
  rejected, 123 + 5 minute delay; numeric argument rearms five minutes.
- Executed actual-controller synthetic cadence reproduction: 128-minute detailed
  ticks with existing cadence, initial 256-minute wait with missing cadence.
- Executed mocked JSON/HTML 503 client-plus-scheduler reproduction: retry versus
  terminal timerless pause. No live error injection or private fixture data.
- Five focused v1.1 sync tests passed again in the primary investigation,
  covering staged progress, restart/validation and whole-domain activation.
- Read live admin rendering, exact accessible chart values, health identity and
  public aggregate API; kept observation timestamps and metric definitions distinct.
- Documentation governance passed; `pnpm run test:preflight` passed all 20 tests
  and root-layout/whitespace checks. Only this research document is changed.
