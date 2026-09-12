---
title: Electron real-history control-plane responsiveness measurement
date: 2026-09-05
type: research
status: targeted-v2-live-copy-passed
---

# Electron real-history control-plane responsiveness measurement

This record describes a repair to the macOS real-history QA measurement, a
source-proven duplicate quick-reload removal, and the targeted copied-profile
result used to retain its 250 ms responsiveness budget. It is a local unsigned
candidate result only. It does not qualify the current integration, a release
artifact, or a full private-history refresh.

## Evidence boundary

Two preserved, content-free macOS full-run receipts associated with source
revision `d08e5411` failed the control-plane gate. Each records the same value
for its aggregate maximum and p95: 471 ms in one attempt and 582 ms in the
other. Those values establish that the prior gate failed. They do not identify
which endpoint was slow.

The prior sampler issued three concurrent pairs of `GET /api/local/health` and
`GET /api/local/refresh` requests, then calculated nearest-rank p95 over the
six combined timings. Its rank was `ceil(6 * 0.95) = 6`, so the reported p95
was necessarily the maximum of the combined endpoints. When that gate failed,
the receipt builder also set its sample and success counts to zero. A zero
count in those historical failures therefore does not mean that no probes ran.

This diagnosis agrees with the pre-existing [detailed accounting performance
plan](../plans/2026-09-01-detailed-accounting-refresh-performance.md#1-freeze-a-reproducible-private-benchmark-protocol): three repetitions are not
a defensible p95 sample and a larger, predeclared sample must identify its
count and percentile method.

Committed source comparison established that `d08e5411` is an ancestor of the
pre-change qualification revision and that the relevant local route and
refresh-path structure had not changed in between. The measurement defect was
therefore still present before this repair.

## Measurement contract now implemented

The real-history QA script retains the v4 top-level control-plane fields so
old receipts remain readable. New samples add an optional, content-free
`endpointLatency` object with a declared sampling version and separate
summaries for `health` and `refreshStatus`. The original repaired sampler is
`endpoint-separated-v1`; the targeted cancel sampler below adds explicit phase
coverage as `endpoint-separated-v2`.

| Phase | Rounds per endpoint | Gate | Purpose |
|---|---:|---|---|
| Warm-up | 2 | Each response must remain below the 3,000 ms per-request ceiling | Separates connection/startup effects from the measured steady phase |
| Active | 20 | Each endpoint needs 20 successful in-flight responses; its nearest-rank p95 must be at or below 250 ms and every response below 3,000 ms | Supplies the percentile qualification sample |

The two endpoints are requested concurrently in every round. Individual
latencies remain only in process memory long enough to calculate each summary;
the receipt contains only counts, maximum, p95, endpoint name, and phase. The
top-level `sampleCount` now means active rounds, and its top-level p95 is the
larger of the two active endpoint p95 values. The warm-up maximum remains
visible in the top-level maximum because the individual response ceiling still
applies to every phase.

The collection interval is 250 ms and the control-plane timeout is capped at
75 seconds. That permits the complete sample under the 3,000 ms individual
ceiling while keeping a pathological run finite. At the 250 ms target it
normally completes substantially sooner. A failed receipt retains bounded
observed counts and endpoint summaries instead of erasing them; it still marks
`active: false` and cannot qualify a run.

The generic reader continues to accept historical v4 three-round and
endpoint-separated-v1 evidence. New successful `cancel` and `snapshot`
receipts require the v2 phase-coverage shape, so reader compatibility cannot
turn a newly built cancellation qualification into a legacy/v1 pass.

The v2 cancel sampler begins only after an observed running refresh with
`quickResultAt: null`. Its first sampled `/api/local/refresh` response must
also be pre-quick. It then takes two warm-up rounds and at least twenty active
rounds, continuing at 250 ms until a sampled accepted refresh response observes
quick publication or the existing 75-second probe cap expires. The v2 receipt
records only booleans and per-phase round counts: `startedBeforeQuickResult`,
`quickResultObserved`, and warm-up/active before-versus-at-or-after quick
publication counts. Each pair of counts must sum to that phase's sampled
rounds. A quick publication in warm-up remains in warm-up coverage and in the
maximum; it is never claimed as an active pre-quick observation.

After the valid v2 control-plane probe returns, the harness sends Cancel
immediately. The renderer timer starts with the probe but is awaited
separately, so it cannot add a status poll or delay the cancellation action.
The v2 validator requires all twenty active refresh-status responses to match
the still-running or cancelling refresh; post-cancel responses never enter the
active percentile. If a refresh completes in the remaining race to the
renderer click, the receipt remains an honest `cancel_unavailable` failure
rather than recasting terminal responses as active samples.

## Earlier isolated live-copy result

On 2026-09-05, a clean local measurement candidate
`81cadfc8735862fad1027163fc823a7f979607e8` was built from base
`dc93b273bb5e0b914dddff4b0efa472541dbbc0a` plus QA patch digest
`721171e9541802c1bc9363a8a4c73393b921de8da30797b8eb61a11b799d94e4`.
The local unsigned app bundle was bound to `app.asar` SHA-256
`e66c0adeacc88886a9f35b33885f20ca834256cc64528b5a699174cb2339b937`.
The [content-free durable result receipt](file:///Users/adamallcock/Documents/Coding/app-usagemonitor/.release-build/electron-unified-0.1.18-builds/81cadfc873-real-history-measurement/real-history-control-plane-result.json)
and its adjacent provenance/package receipts record those bindings. Its private
profile was a fresh SQLite-backup-and-device-salt copy. The local-only
cancel-mode run passed without central origin or contribution capability.

Both endpoints completed two warm-up rounds and twenty active rounds with all
responses successful. In the active phase, `/api/local/health` and
`/api/local/refresh` each recorded a 1 ms p95 and 1 ms maximum; the receipt's
top-level p95 and maximum were also 1 ms. The independently sampled renderer
timer advanced, the first useful refresh result arrived in 2,329 ms, and the
cancel and retry requests were accepted with bounded loopback responses.

This is evidence that the 250 ms budget is achievable on an actual copied
history profile with the original endpoint-separated method. It does not
establish that the two historical aggregated failures were harmless, identify
their exact old stall, or qualify a later integration/release artifact. It is
one cancel-mode run; full, relaunch, and post-integration evidence remain
separate gates.

## Preserved initial v2 sequencing receipt

The first v2 candidate, source
`9bb98fe3deed9735046b3c3c09a8bb0951be1106`, was built from the same base with
patch digest `46b92f5ddbc83617a9d1aa79329f06bac5ccc814dcf81941c8e095c754292f29`
and bound to `app.asar` SHA-256
`8913efb00d34a360d2a5f2ab8526abcbc6eb40d3f91eddac18d114ac09eaa7d3`.
Its [content-free QA receipt](file:///Users/adamallcock/Documents/Coding/app-usagemonitor/.release-build/electron-unified-0.1.18-builds/9bb98fe3deed-prequick-sequencing-failure/real-history-receipt.json)
is retained because it observed valid v2 coverage: warm-up was 2/0 pre/post
quick, active was 3/17, and both active endpoint p95 values were 179 ms with a
481 ms maximum.

That run did not pass cancel qualification. The prior harness waited for both
the timer and control-plane probe, then made an extra post-probe status poll;
the refresh reached terminal success before that delayed cancellation action.
Its `control_plane_phase_coverage_invalid` status therefore describes the
sequencing gate, not a p95 breach. The receipt is diagnostic evidence only and
does not qualify the threshold or cancellation path.

## Targeted optimized v2 live-copy result

On 2026-09-05, the corrected local candidate
`07e639d386a57d70a2063371506eacd1d8de6215` was built from base
`dc93b273bb5e0b914dddff4b0efa472541dbbc0a` with the exact six-file
performance/QA patch digest
`8c66e6175cfeb9e2b4dc9f952f5d48297337271b6222e6a7053e7bc49e3d767e`.
The unsigned directory app was artifact-verified and bound to `app.asar`
SHA-256 `8913efb00d34a360d2a5f2ab8526abcbc6eb40d3f91eddac18d114ac09eaa7d3`.
The [durable content-free QA receipt](file:///Users/adamallcock/Documents/Coding/app-usagemonitor/.release-build/electron-unified-0.1.18-builds/07e639d386a5-prequick-performance/real-history-receipt.json),
[result summary](file:///Users/adamallcock/Documents/Coding/app-usagemonitor/.release-build/electron-unified-0.1.18-builds/07e639d386a5-prequick-performance/real-history-control-plane-result.json),
and adjacent hash-indexed package/provenance receipts preserve those bindings.

The fresh profile was an SQLite-backup-and-device-salt copy. It had no central
origin and contribution was disabled. The cancel-mode run passed its source
and artifact binding, local network boundary, timer, cancellation, retry, and
clean-quit gates.

| Measurement | Observed result |
|---|---|
| V2 coverage | First sampled refresh was pre-quick; warm-up pre/post was 2/0 and active pre/post was 4/16 |
| `GET /api/local/health` active samples | 20/20 successful; p95 208 ms; maximum 364 ms |
| `GET /api/local/refresh` active samples | 20/20 successful; p95 207 ms; maximum 364 ms |
| Aggregate active p95 / maximum | 208 ms / 364 ms |
| Renderer timer | Advanced; 7 samples, 4 unique values |
| Cancellation | Acknowledged in 2 ms; terminal cancellation in 7,125 ms; exact POST latency 1 ms |
| Retry cancellation | Accepted and terminally cancelled; exact POST latency 21 ms |

Both endpoint p95 values satisfy the 250 ms budget. The 364 ms maximum is
above that percentile budget but below the independent 3,000 ms per-request
ceiling, so it remains visible rather than being treated as a p95 pass/fail
substitute. One targeted v2 run does not identify the source of the historical
471/582 ms aggregates, establish a before/after wall-time attribution for the
duplicate reload removal, or support a threshold increase.

### Post-receipt QA-only hardening

After the exact candidate above was measured, a read-only boundary review led
to three harness-only hardenings: successful `cancel`/`snapshot` receipt
construction now requires v2 coverage; measured fetch latency and the
75-second control-plane deadline use the existing monotonic clock; and any
safe-integer latency over the 3,000 ms ceiling serializes as the bounded
`3,001` sentinel, meaning **at least** 3,001 ms rather than an exact elapsed
time. The ceiling and all pass/fail gates remain unchanged.

This is source/test/documentation hardening only. It did not rebuild or run a
new candidate, change runtime modules, rewrite the `07e639d386a5` durable
receipt, or alter its source/ASAR bindings. The passing receipt above remains
the exact, earlier targeted local-copy result; this later work is not a new
source-bound qualification.

### Phase coverage limitation

The preserved `d08e5411` full-mode sampler began as soon as the startup
refresh ID was accepted and stopped after its three successful control-plane
rounds while the full run continued toward terminal state. It recorded no
progress-phase marker, so its 471 ms and 582 ms failures cannot be placed
relative to quick-result publication, projection work, or the terminal reload.

The earlier candidate used the post-quick cancel sampler: it waited for a
published `quickResultAt` and either the `quick_result` phase or the subsequent
running unified-index scan. In the refresh controller,
`dataStore.reload({ purpose: "quick" })` is awaited before that state is
published. Its 1 ms receipt therefore cannot measure that reload's cost.

The targeted v2 cancel sampler starts before quick publication and requires an
observed quick transition before it may qualify. The passing candidate sampled
four active rounds before and sixteen at or after publication, then cancelled
immediately after its twenty valid active rounds. It can therefore measure the
quick-publication boundary, but it does not claim complete-refresh, later
full-projection, or terminal-reload coverage. Those remain a separate
phase-labelled full-run requirement.

## What the historical result does and does not establish

The 250 ms budget should remain unchanged. The two historical values are
aggregated six-value maxima, so they cannot support raising the threshold to
582 ms or a nearby rounded value. The targeted v2 result retains the budget on
one copied-profile candidate; phase-labelled full runs would still be needed
to determine whether one endpoint, both endpoints, or a later refresh period
can breach that user-experience budget.

The harness measures complete loopback `fetch` plus JSON decoding from its
Node QA process. It runs a renderer timer probe separately. A delayed
loopback response can delay refresh-status polling or cancellation feedback,
but it is not by itself proof that the Electron renderer event loop froze.

Static source review identifies these boundaries:

| Boundary | Verified behavior | What remains unproven |
|---|---|---|
| `GET /api/local/refresh` | Returns a structured clone of the bounded refresh state and serializes it | It is not established as the source of either historical aggregate latency |
| `GET /api/local/health` | Performs an asynchronous unified-index presence check when the incremental contribution capability is configured | It is not established as the source of either historical aggregate latency |
| Unified ingest and full projection on macOS | Use worker-thread paths for the expensive full work | Worker use does not rule out short main-event-loop work around progress handling |
| Quick-mode progress and terminal handling | A successful `quick_result` reload was followed by a second terminal `purpose: "quick"` reload of the same snapshot | The duplicate rebuild is proven and removed; the v2 result establishes the retained p95 gate but not a causal before/after wall-time attribution |

## Proven scoped change and targeted result

The controller now records a successful progress-stage quick publication and,
for explicit `mode: "quick"` only, skips the redundant terminal quick reload.
If the progress reload failed or was never published, terminal settlement still
retries it. Detailed mode retains its quick reload followed by full reload.

All three controller reload paths now request `returnOverview: false`. The
data-store boundary validates that option and strips it before invoking the
builder, so the controller does not request an unused return overview while
ordinary callers retain their existing default return behavior. Direct tests
cover the successful skip, failed-progress fallback, detailed quick/full
sequence, and the resource-limit reload path.

The earlier v1 copied-profile receipt predates this change and cannot qualify
it. The passing v2 candidate contains only the two data-store publication files
and the QA/refresh safety, measurement, and test files described here, applied
to a clean `dc93b273` base. It excludes the separate, disabled accountless
prototype and is not the eventual full integration artifact.

## Live-copy qualification safety gate

The v1 and retained v2 attempts described above each used an isolated,
owner-only copy of derived application state through SQLite backup and
device-salt validation; the pre-existing durable profile was not changed. The
packaged app necessarily read each fresh copy as normal runtime input. The QA
harness and this research reviewed only content-free launcher, package, and
result receipts, and did not extract or retain raw profile records. Every run
used a private development export identity, no central origin, and a local
network boundary.

Source review found a separate account-observation path in the normal refresh
runner that could select the macOS Keychain backend with `createIfMissing:
true`. The development export identity avoids the contribution-preparation
Keychain path, but does not itself substitute for the account-observation
secret. That was a real no-credential-mutation gap.

The refresh runner now recognizes only the explicit
`macos-electron-local-qa-v1` lane and supplies no account-observation secret
loader in that lane. It does not invoke the production selector, so it cannot
instantiate, read, or mint that Keychain capability. The quota observation can
still be captured with an unavailable/unattributed account scope; the
development export identity is never reused as an account secret. Direct
contract coverage verifies both the no-selector/no-loader case and unchanged
ordinary-lane selection. The isolated candidate was newly packaged, and its
verified `app.asar` contained that guard before the live-copy result above.

The explicit QA lane did not select, read, or mint an account-observation
Keychain secret, and the development export identity was never supplied as an
account secret. No credentials or raw profile content were retrieved or
retained by the QA evidence, and no upload occurred.

The exact local optimized candidate has now been built, bound to its source
and `app.asar` identities, and measured from a fresh copied profile with no
competing workload. The prior v1 and failed sequencing receipts are preserved.
Keep the 250 ms threshold: the endpoint-specific v2 p95 result passes it, and
the historical aggregated failures do not justify changing it.
