---
title: Daily model performance telemetry requirements
date: 2026-09-20
type: spec
status: in-progress
---

# Daily model performance telemetry requirements

This specification qualifies the separate daily performance stream alongside
the [v1.2 implementation plan](../plans/2026-09-20-turn-boundary-telemetry-plan.md).
Performance collection has its own capability, policy and activation gates;
it must not delay continuity collection or add timing fields to usage events.
The existing exact-total repair and non-additive cache-write TTL subdivision
remain independent work. Cache-retention-v2 calculations stay unchanged.

The original investigation used main at `9385bad2` and the foundation based on
`0fb6a5e6`. Current integration is on `codex/telemetry-v12-integration`, with the
newer remote receipt/tool-free reporting behavior incorporated. Persistent
full-turn/mode evidence, fixed histograms, independent report transport and
typed storage, local scheduler and independent consent now exist in source.
The real local controller/worker path is qualified with synthetic initial,
append and late-completion evidence; report revision and source identity advance
for each mutation. The owning local suite passes 381 tests and the browser suite
passes 995 after remote integration. Hosted chart publication and installed/deployed qualification remain
open; the dated foundation checkpoints below describe their original revisions.

## Measurement requirements

| Requirement | Telemetry consequence |
| --- | --- |
| TPS is eligible output tokens divided by their matched response duration, multiplied by 1,000 for milliseconds. | Carry distributions of per-turn ratios. Preserve token and duration sums separately for an explicitly different ratio-of-sums statistic. |
| Output includes reasoning output. | Never add reasoning tokens to an already combined output count. |
| TTFT is a separate qualified first-token measurement. | Keep its histogram and eligible-turn count independent from TPS; a TTFT-only turn remains useful. |
| Full turn completion is elapsed start-to-completion time, including tool waits. | Retain a separate positive-millisecond histogram and eligible-turn count; response-duration sums cannot reconstruct it. |
| Local charts use P10, P25, P50, P75 and P90 across eligible turns. | Merge compatible histogram counts before deriving approximate hosted percentiles. Never average contributor or daily percentile values. |
| One eligible turn contributes one observation to each available metric. | Histogram weights are turns, not responses, tokens, elapsed time or contributors. |
| Local bands require at least five observations; sparse medians remain available. | Preserve this rule separately for each metric after pooling compatible reported samples. |
| Local windows are UTC 7 days, 30 days and all time; all-time spans over 366 days use Monday-aligned weeks. | Daily aggregates support the selected UTC days and Monday regrouping; missing days remain missing. The exact subday threshold needs the presentation decision described below. Window selection never changes retained history. |
| The current chart combines receipt/legacy speed samples with a qualified tool-free fallback and includes all reasoning efforts. | Retain provenance dimensions so incompatible future methods cannot mix, then combine qualified compatible cohorts before calculating displayed quantiles. |
| Counts and measurements use the same selection. | Carry total turns, TPS turns, TTFT turns, completion turns and timed responses without implying that TPS and TTFT populations are paired. |

Unknown or unqualified timing is unavailable, not zero. A measured zero TTFT
is distinct from missing TTFT. Invalid or zero speed durations cannot produce
a rate. Inter-request gaps, boundary masks, event ranks and full-turn duration
are not substitutes for response timing.

The producer follows the reporter's sample-field eligibility, not a new
`quality = complete` filter. Valid covered-response samples survive some
incomplete whole-turn states. Assign each turn to one speed-method partition:
eligible receipt, eligible legacy, eligible tool-free fallback, or unavailable speed. TTFT and completion time can contribute
in any of those partitions. This keeps denominators disjoint and preserves
TTFT-only turns. Unknown effort remains explicit. The current local chart
excludes unrecognized models; any additional global unattributed-turn coverage
must be identified separately from its existing chart counts. The source
parser's `auto-review` label is not in the current local chart model set or the
wire catalog; it remains excluded rather than being silently renamed to the
separate reviewed `codex-auto-review` identity.

Attribute the UTC day from the stored completion timestamp, not the turn start
or a later upload time. Compatible receipt and legacy provenance is internal;
the current local product decision combines those samples in one displayed
speed distribution rather than presenting logging formats as competing metrics.
Current Windows capability reports timing unavailable without starting a
worker; adding a wire schema does not qualify a Windows timing producer.

The local all-time day/week switch uses the earliest precise completion time.
A day-only payload cannot reproduce that instant: near the 366-day threshold,
its uncertainty is less than one day. Hosted presentation must define the
switch using complete UTC calendar days or explicitly retain that uncertainty;
do not claim exact subday parity or add fine-grained timestamps implicitly.
This does not prevent daily histograms from supporting either grouping.

## Histogram information and precision

Use versioned, bounded sparse integer counts with fixed edges. Every person
and compatible client uses exactly the same ranges: there is no per-person
range selection or rescaling. Add counts in corresponding buckets before
calculating pooled percentiles. The staged resolution is 2 tokens/second in the main speed range and geometric
TTFT edges with approximately 15% relative width. Declare all edges and units
in the contract. Include explicit tails; the observed maximum in one
contributor's corpus is not a provider-neutral measurement limit. Never clip
or discard high-speed, slow-latency or subsecond observations to fit a chart.

Preserve sample counts, token/duration sums and extrema in bounded integer
units. If fixed-point speed extrema are used, retain conservative rounding
bounds. Check arithmetic overflow before mutation or aggregation. Empty
histograms require zero eligible samples and null extrema, rather than
fabricated zero measurements. Histogram bucket sums must equal their metric's
eligible sample count, which cannot exceed total turns.

Fixed histograms do not preserve exact local quantiles, even with sums and
extrema. A synthetic witness uses five turns with 10,000 ms each:

| Output token counts | Total tokens | Speed extrema | Exact median TPS |
| --- | ---: | --- | ---: |
| 81, 82, 83, 94, 95 | 435 | 8.1–9.5 | 8.3 |
| 81, 85, 85, 89, 95 | 435 | 8.1–9.5 | 8.5 |

Both produce the same five counts in the 8–10 TPS bucket and the same total
duration. Therefore a histogram reader must identify its approximate method
and provide conservative bounds for each quantile. Use the local linear
order-statistic interpolation target `(n - 1) * p` when qualifying those
bounds. Interpolation within a bucket is an estimate, not recovered evidence.
Tail buckets and narrow distributions may have insufficient resolution;
publication must expose that limitation or withhold the point estimate.

The 15% edge spacing and 2 TPS bucket width are not guaranteed relative error
bounds on the final percentile or the width of a model's displayed band.
Qualify with synthetic singletons, sparse groups, ties, boundary values,
tails, bimodal groups, method mixtures and day-to-week regrouping. Do not
generalize error measurements from one contributor into a fleet guarantee.

The implemented `performance-histogram-v1` scheme has 61 speed buckets:
60 half-open intervals from `[0,2)` through `[118,120)` TPS and an overflow
bucket at 120 TPS. Zero TPS remains ineligible. Its 58 TTFT buckets contain
zero, `[1,500)` ms, logarithmic intervals whose exact integer upper bounds
are `ceil(500 * (115/100)^k)` for `k = 1..55`, and overflow starting at
1,089,812 ms. Integer edges are generated with rational arithmetic. Tails
retain observed extrema instead of discarding samples. Full turn completion
uses these same millisecond edges with its own `turnDuration` metric; zero is
ineligible and its reserved bucket 0 must remain empty. No TPS or TTFT edge,
bucket index or percentile rule changes with this extension.

The public helper builds at most 100,000 already-qualified values at a time
and merges at most 200 compatible histograms per call. Larger work can merge
bounded pages; counts and sums must remain safe integers. Its quantile result
includes `approximate: true`, units, sample count and
`performance-histogram-type7-bounds-v1`. Each available percentile has an
estimate plus lower/upper bounds. The estimate is the midpoint of those
bounds; it is not an exact reconstructed sample.

The separate closed `model-performance-daily-v1` record has a 32 KiB bound.
It retains positive total turns, eligible TPS/TTFT/completion turns, timed
responses, speed token/duration sums and three independent histograms. Receipt and legacy cohorts
require TPS coverage for every turn in that cohort; the unavailable-speed
cohort has empty speed evidence and may still contain TTFT or completion
measurements.
Validation checks count agreement, explicit method/scheme versions and that
the ratio of speed sums lies within the histogram's conservative extrema.
Canonical bytes describe measurement content only, without granting upload
authority or proving source membership.

## Fast versus standard and further metric candidates

Usage v1.1 already carries `speedMode` and `apiServiceTier`, independently of
`reasoningEffort`. The staged timing parser, daily projection and performance
record now carry event-time mode evidence. The retained application timing
store and its reader expose these fields through the local performance path.
`speedMethod` means receipt/legacy/tool-free measurement provenance, not Fast mode.
An already combined histogram cannot later be split
by a usage field from another stream.

The current unified usage path maps observed `fast`/`priority` to Fast and
`default`/`standard` to standard, while absent evidence remains unknown. It
retains own-file `rollout_thread_settings` versus `lineage_inherited` provenance
locally. The performance stream additionally distinguishes an explicit
per-turn `turn_context.service_tier` declaration as
`turn_context_service_tier`; it is the authoritative mode evidence at that
turn's task boundary. This path does not backfill history from the mutable
thread-database setting. For Codex it leaves API service tier unknown rather
than equating a subscription speed choice with an API tier. The v1/v1.1
projection sends the mode/tier labels but omits local `tierSource`, so
historical hosted rows alone cannot distinguish those evidence bases.

The performance cohort key retains `speedMode`, `speedModeSource` and
`apiServiceTier` separately from model, effort and measurement method.
Fast/standard/other requires observed own-file, explicit per-turn context, or
qualified lineage evidence; unknown requires unobserved provenance, and a
mixed turn stays mixed. The current timing parser qualifies own-file thread
settings and explicit per-turn context declarations at the task boundary; its
existing fork exclusion remains in force. Supporting lineage in the wire
vocabulary does not establish lineage evidence in this parser.

Settings apply only at or before the turn. A setting observed later cannot
backfill an earlier turn, and a change during a turn prevents attributing the
whole measurement to its final mode. Missing, malformed or ambiguous mode
stays unknown without invalidating otherwise qualified timing. Explicit null
is unknown. Codex Fast is not proof of delivered API priority service: its API
tier remains unknown. There is no fallback to the current thread-database
setting. Old rows with no mode fields remain usable as unknown-mode evidence.

Full completion time is retained as `turn_duration` in qualified local rows
and `completionHistogram` plus `completionTurns` in the daily record. The
parser validates the reported `task_complete.duration_ms` against start and
completion timestamps using the existing 2,000 ms endpoint-skew tolerance,
requires completion at or after its start, a stable model and no error, and
keeps this independent of TPS interval coverage. It preserves the source
reported elapsed value rather than replacing it with a wall-clock subtraction. The value includes tool waits. The
existing timing row's `duration` is matched model-response time and cannot
substitute for it; historical daily totals cannot reconstruct a completion
histogram. Missing, zero, unsafe or inconsistent completion values remain
unavailable. Valid zero TTFT remains a distinct supported observation.

The record family has not been activated in production. Its independently
negotiated field dictionary is now `telemetry-performance-registry-2026-09-21.1`;
existing usage v1/v1.1/v1.2 and TPS/TTFT bucket semantics remain unchanged.

The following priorities are proposals; they do not add fields or collection
authority to the staged contract:

| Candidate | Use and information requirement |
| --- | --- |
| Tail latency and consistency | P95/P99 and percentile spreads can reuse fixed histograms through a separately qualified reader, with approximation bounds and stricter sparse-tail rules. The current helper exposes only P10/P25/median/P75/P90. |
| Measurement coverage | Existing total/TPS/TTFT counts expose turn coverage. Response coverage additionally needs the observed-response denominator, not only `timedResponses`. The local source has `sample_total_responses`; the daily record currently omits it. |
| Errors, retries and cancellations | Require explicit bounded outcome categories, an attempts denominator and retry lineage. Missing timing or an unknown usage outcome cannot serve as a failure counter. |
| Streaming smoothness | Inter-chunk gaps, stalls and token latency need sufficiently precise chunk/token observations; current response-interval sums cannot reconstruct them. |
| Combined performance targets | A fraction meeting both a TTFT and speed target needs paired observations or locally computed joint counters. Separate marginal histograms cannot recover that intersection. Requests-per-second goodput additionally needs a qualified observation-time denominator. |
| Reasoning/output composition | Local covered reasoning-token counts could support an aggregate reasoning share. Separate visible-output or reasoning generation speeds need component-specific timing; token splits alone are insufficient. |

For fair comparisons, prioritize mode/tier and matched model/effort first.
Coarse input-context, output-length and cache-coverage cohorts are useful next,
but require a qualified local join before aggregation. Bound the number of
cohorts rather than multiplying every dimension into a sparse cross-product.
Model accuracy or task success requires a separate evaluation/feedback signal;
speed, tokens and tool exit status alone do not establish answer quality.

These distinctions align with the separate operation, agent, tool and streaming
boundaries in the [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md),
which are currently marked development, and the latency/throughput definitions
in [NVIDIA GenAI-Perf](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_analyzer/genai-perf/README.html).
[NVIDIA's goodput definition](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_analyzer/genai-perf/docs/goodput.html)
is completed requests per second satisfying specified performance constraints;
a threshold pass fraction without a time denominator should use a different
label. These references inform candidate definitions, not claims that the
current local source exposes every measurement.

## Source coverage, replay and mixed clients

On 2026-09-21 the owner chose daily histograms and ordinary upload/replay
deduplication without a new cross-device membership artifact. This supersedes
the earlier proposal to block pooling until shared turn membership was proven.
Usage accounting retains its separate, stricter occurrence reconciliation.

A histogram describes measurements rather than unique source membership.
Identical or partly overlapping histories on different devices can therefore
contribute more than once. Pooled counts and percentiles represent **reported
samples**, not an owner-wide distribution of unique turns. Presentation and
coverage metadata must make this distinction explicit; do not claim that
matching payload digests, device identifiers or day equality establish
cross-device uniqueness. No source path, raw turn identifier, per-turn timestamp
or membership artifact is added to the daily payload.

Each device/day has immutable report revisions bound to exact method, parser,
schema, dictionary, bucket scheme and source generation/digest. Retrying the
same revision is idempotent. Replacing it supersedes only that device's exact
prior report and invalidates dependent day/week/publication results. Never
sum both an old and replacement revision, elect an owner-wide winning device,
or discard another client's unique history. Partial days, late corrections,
history backfill and withdrawn source eligibility use this dependency model.
Local replay and duplicate-source handling remain required; the decision does
not authorize retry overcount or unstable source identity.

Reports from supported clients can be combined by adding corresponding fixed
histogram buckets. Preserve contributor/device/report counts and observation
coverage alongside reported sample counts. Client release version alone is
never grounds to replace another client's report. Clients without performance
support continue their supported usage streams.

Owner erasure removes retained reports and invalidates pooled outputs. Restore
preserves report revisions and deletion authority before advertising readiness.
A future privacy-reviewed membership proof may improve cross-device uniqueness,
but is outside this implementation and is not a continuity or performance
collection gate.

## Independent delivery and privacy

The measurement representation uses integer milliseconds, integer token and
sample counts, and integer centi-TPS extrema. Bucket IDs fit in one unsigned
byte: 61 speed buckets and 58 millisecond bucket positions including tails.
TTFT permits bucket 0; full completion does not. A future typed
layout should use bounded integers and dictionary references, preserving sparse
counts rather than storing per-turn timing rows or repeated floating edges.
The record contract alone does not choose or qualify a database encoding.

Keep core v1/v1.1 and v1.2 continuity contracts closed. The performance stream
uses an independently versioned record and capability; clients lacking it
continue contributing their supported streams. Failure, refusal or delay of
performance preparation cannot invalidate a complete continuity day, consume
its retry budget indefinitely or advance its receipt cursor incorrectly.

The existing v1.1 capability response has exact format and key checks. Do not
append a performance format or metadata property to it. Use a separate
versioned capability response or explicit negotiated representation; absence
means unsupported performance, not failed core contribution. Rollout is per
client capability and exact authorized version, with no fleet-wide version
floor, date cutover, or owner-wide preferred client. Keep performance
authorization, consent/policy version and optional stream state separate from
the exact legacy settings shape. A global sharing opt-out still stops every
stream; a performance-specific failure or pause must not pause continuity.

Use separate prepared-set identities, directories, queue discovery and artifact
retirement rules so older clients cannot mistake performance files for legacy
uploads or delete them as obsolete. Give performance its own day cursor,
source generation/digest, immutable manifest revision, receipts,
retry count/deadline and bounded days/bytes/time budget. Foreground work may
share a scheduler but must reserve a bounded independent budget and outcome
for each stream. No new daemon or hidden scan is authorized by this design.

Distinguish retryable transport failures from unsupported platforms, absent
capabilities and unavailable source evidence. Do not retry
unavailable timing indefinitely or serialize it as zero observations. Preserve
global pause/disconnect/opt-out semantics without inventing a consent event.

Hosted erasure covers retained reports, revision provenance, revisions,
receipts and derived caches. Authority epochs must reject late retries and
restores that would resurrect erased evidence. Local prepared sharing artifacts
have their own receipt-bound cleanup; hosted erasure does not authorize wiping
the retained local timing history. A database that never activated performance
may legitimately lack its tables without blocking core restoration. A database
that did activate it cannot silently lose its performance/deletion history and
claim a complete restore.

The proposed daily measurement payload contains no prompt, response, command,
path, raw session or turn identifier, or timestamp finer than the UTC day.
Transport authorization and any new coverage proof require their own privacy
review. A valid measurement record is not itself authorization or proof that
its samples can be pooled. Speed mode stays unavailable without qualified
per-turn evidence; never backfill a day's history from current settings.

The reviewed local source currently establishes Codex timing semantics only.
A provider-neutral measurement shape does not qualify an Anthropic or other
provider timing adapter. Such adapters need equivalent source, interval,
numerator and completeness evidence before contributing compatible samples.
Provider/model identities must be exact reviewed catalog pairs; arbitrary
custom labels are not wire data. Adding a provider or model requires the
catalog and corresponding contract validation to agree. This is independent
of qualifying that provider's timing adapter. The future capability/manifest
must bind the accepted dictionary and privacy tuple; catalog growth must not
silently send new identities to a reader whose vocabulary is older.

## Source evidence

The local behavior was inspected in main at `9385bad2`, without changing that
checkout. The following files define the relevant behavior there; they are
not all present in the older foundation base:

| Source | Evidence used |
| --- | --- |
| `src/providers/codex/inference-timing.js` | Matched response intervals, covered-output numerator, modern/legacy exclusions and independently qualified TTFT. |
| `src/reporting/model-performance.js` | Measurement method 3, per-turn eligibility, Type-7 quantiles, five-sample bands and UTC day/week windows. |
| `src/platform/inference-timing-store.js` | Store-local identity, retained measurements and exported-row identity limits. |
| `src/local-unified-index.js`, `src/local-unified-index-build.js` | Device-salted usage occurrence identity; no existing cross-device timing membership proof. |
| `src/contribution/telemetry-v11-sync.js` | Exact legacy capability formats; performance cannot be appended transparently. |
| `src/application/local-incremental-contribution-sync.js` | Existing shared pause/retry state; independent delivery needs separate stream state. |

The foundation's [histogram primitive](../../packages/telemetry-contract/src/performance-histogram.js),
[daily record validator](../../packages/telemetry-contract/src/telemetry-performance-v1.js)
and [schema factory](../../packages/telemetry-contract/src/telemetry-performance-v1-schemas.js)
implement measurement validation. The
[Codex parser](../../src/providers/codex/inference-timing.js) qualifies local
rows and the [daily projector](../../src/contribution/performance-daily.js)
allowlists those rows into bounded daily cohorts. Neither grants upload authority. Generated mirrors and public types describe the
same staged contract.

The projector accepts at most 100,000 qualified rows and 1,024 cohorts per
call, requires an explicit UTC completion day/provider/current cutoff, and
checks safe-integer totals before returning records. Daily collection applies
the UTC day predicate to both primary and supplemental SQLite reads before
the row limit, so a larger retained back catalog does not exhaust a small
day's selection. Source revision facts still cover the retained source set. It preserves the local
reporter's receipt/legacy/tool-free eligibility; unavailable-speed rows can still
contribute independent latency. Older rows lacking the new fields preserve
TPS/TTFT with unknown mode and absent completion. Callers must establish source
uniqueness; equal row values are neither a duplicate proof nor a reason to
discard observations. Persistent integration requires a forward store migration
and qualified source replay for backfill. Older active parser checkpoints
cannot invent new mode or completion proof merely because a newer parser
resumes them. Preserve prior timing identities and retained measurements
through that migration; do not relabel or recreate an older database. The
application must also invalidate or rebuild affected daily revisions when
later source evidence contradicts already-emitted mode or model attribution.
An incremental parser callback is not authority to seal a day permanently.

## Completion gates

1. Trace local measurement, eligibility, counting, filtering and rendering to
   source and tests, separating implemented behavior from proposed changes.
2. Qualify the closed daily measurement payload, integer bounds, histogram
   merging and quantile uncertainty with synthetic fixtures and generated
   schema/type/browser parity.
3. Qualify idempotent replay and per-device report revisions across copied
   histories, complementary clients and corrections. Label pooled counts as
   reported samples and preserve the accepted cross-device overlap limitation.
4. Integrate the qualified local timing source and independently negotiated
   preparation, transport, typed storage, readers, erasure and restore.
5. Render hosted charts with the correct approximation and coverage semantics;
   separately qualify installed-client and deployed-service behavior.

The current browser DTO accepts closed quantile points and has no representation
for approximation bounds. Qualify a versioned presentation contract or an
explicit companion metadata contract before publication; do not silently feed
estimated histograms into a view that claims exact local empirical percentiles.

These are performance-stream gates, not additional prerequisites for collecting
the already planned continuity fields.

## Qualification checkpoint — 2026-09-20

All new measurement fixtures are synthetic and content-free. No upload,
production migration, installed client or hosted chart was changed. The
measurement contract is implemented and staged; completion gates 3–5 remain
open, and the local timing adapter still needs integration into this base.

| Check | Result and boundary |
| --- | --- |
| Existing local timing parser/store/projection/API/browser audit | 62 tests passed against main's timing implementation; separate evidence from foundation integration. |
| Final performance, v1.2 preparation/evidence and schema suites | 42 passed. Includes reviewed provider/model pairing, unavailable and zero TTFT, canonical bytes, privacy negatives and unchanged usage shape. |
| Numerical qualification | 600 seeded cohorts matched independent exact Type-7 quantile bounds; all finite bucket edges and immediate predecessors passed, as did safe-count overflow refusal. These tests establish bounds, not fleet accuracy or exact sample recovery. |
| Existing export/privacy contract gate | 13 passed; browser, schema and embedded admin mirrors passed, including all 40 schema copies. |
| Packaging closure | Electron package suite 13 passed, local-review policy 10 passed and client exporter 3 passed after adding explicit new-module allowlists. Focused shell-replacement and macOS package-capture checks also passed. This is synthetic artifact qualification, not a native installation or signed release. |
| Exact-total regression | Both local-index retirement/parity tests passed after asserting v16's captured totals and deliberately omitting totals only in the mismatch fixture. Mismatch detection and reading retained indexes after raw-source deletion remain covered. |
| Worker integration | 1,855 tests passed across 144 files. The final contract refinements were then checked through the focused suites, refreshed npm-installed package copies and Worker TypeScript. The dry-build continuation passes package/endpoint guards and stops at the clean, committed release-tree prerequisite; deployment dry runs remain unqualified. |
| Repository checks | Documentation, preflight and architecture checks passed. The initial full root run was not green: 4,930 passed, 37 failed and 46 skipped. Packaging and total-capture fixture regressions found there were repaired and checked separately. Remaining broad failures include protected R7/source receipts, sandbox/platform constraints and stale baseline accounting/inventory/release expectations; this checkpoint does not claim a green full repository or release gate. |

The four streamed-accounting failures were traced to pre-existing fixture
assumptions about identical memory estimates, history trimming and optional
precompute budgets. Their source and test files are unchanged by this work;
no accounting implementation or resource guard was relaxed. Protected R7
receipts were not regenerated to disguise source changes.


## Qualification checkpoint — 2026-09-21

This foundation checkpoint precedes the transport, store and controller
qualification recorded at the beginning of this specification.

The staged foundation now includes full turn completion duration, event-time
Fast/standard mode cohorts, the qualified Codex parser and a bounded pure daily
projector. The public parser-to-projector fixture verifies 200 combined output
tokens (including 100 reasoning tokens), 2,000 ms of response timing, 202,000 ms
of full turn time including tool waits, 100 ms TTFT, Fast mode and unknown API
tier. Projecting the same qualified row without new fields preserves its prior
TPS/TTFT and emits unknown mode with unavailable completion.

All contributors continue to use exactly the same TPS bucket ranges. The
rollout plan explicitly retains v1, v1.1 and v1.2 clients side by side and gives
performance its own capability; no minimum fleet version or calendar cutover
has been introduced. New timing evidence does not alter cache-retention-v2.

Focused tests cover full completion boundary refusal, missing timing, mode
changes, restarts, old checkpoints, old rows, safe integer arithmetic and fixed
bucket merging.

| Check | Result and boundary |
| --- | --- |
| Final focused measurement and API contracts | 70 passed, including 29 parser regressions, 9 daily projections, fixed-bucket/quantile qualification, closed record/schema mirrors and exact facade inventories. |
| Local companion | 336 passed. |
| Packaging and export | 23 Electron/local-review package tests and 3 client-export tests passed. These validate local synthetic artifacts, not installed applications. |
| Generated and repository checks | Legacy export/privacy contract: 13 passed. All 40 schema mirrors, browser/admin parity, architecture (584 production files, 2,402 imports), documentation and 20 preflight tests passed. |
| Worker | All 1,855 tests across 144 files passed, after package-copy guards, generated types, TypeScript and script checks. The command then stopped at the clean, committed release-tree prerequisite; deployment dry runs remain open. |
| Full root | 5,049 tests: 4,979 passed, 24 failed, 46 skipped. Two exact API inventory failures were then repaired and passed the focused checks. The remaining 22 failures concern protected R7/source receipts, native/sandbox constraints, accounting fixture assumptions and existing release/tool/web-asset inventories. No protected receipt regeneration, guard relaxation or unrelated cleanup was performed. |

Persistent store/application integration, independent transport and report-revision
qualification remain open. This checkpoint does not establish an installed
client, hosted performance activation or a release.
