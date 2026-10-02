---
title: GCP fast-path cap raise and native-path parity
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP fast-path cap raise and native-path parity

This is a 2026-10-01 receipt for branch `claude/gcp-fp-caps`, built on
`claude/gcp-fastpath-final` `7ef0e144`. It records **local, synthetic**
evidence only: one macOS arm64 workstation (18 cores, 128 GB), a local
PostgreSQL 17 cluster on a private Unix socket, and generated content-free
owners. Nothing was pushed, deployed or seeded; no GCP or Cloudflare resource
was read or written; no production data was read. It does not qualify a Cloud
Run image, the GCP test project, the edge, production volumes or production
parity.

## Owner decisions applied

Both were made in chat on 2026-10-01 and are recorded in the
[fast-path plan](../plans/2026-10-01-gcp-fastpath.md) as OD-11 and OD-12.

1. Raise the GCP caps significantly and prove parity with production's native
   path for owners beyond them.
2. Publish model dates per date, with refused owners excluded and counted
   (`refusedParticipantCount`), instead of production's 14-date block
   withholding. The compute core already did this; only its documentation
   changed.

## The premise, corrected

The bounds the fast path refused at (20,000 occurrences or 32 MiB a day,
120,000 usage rows a 101-day window) belong to `d43c8f92`
`analytics-shared-reducers.ts`, a local experiment at that commit
(`analytics-shared-input.ts`: "Local experiment only. No scheduled handler or
public route imports this module"). Production's graph lane falls back to
`storage-effective-history.ts` `advanceStorageEffectiveAnalysis` for what the
experiment cannot represent, and its daily lane folds every record of an
owner-day with no day bound. So the parity oracle for owners beyond the caps
is that native kernel sequence, not the experiment.

## What changed

### The native path (`src/analytics-v2/native-path.ts`)

The vendored shared reducers still answer first, so every owner-day and window
they answer keeps exactly their result. Only their bound refusals reach a new,
GCP-authored composition of the same exported kernel steps, in memory:

| Shared-reducer refusal | Before | Now (production's native behaviour) |
|---|---|---|
| `day_row_limit` (over 20,000 occurrences) and `day_byte_limit` (over 32 MiB) | Day refused, queued day blocked, every window through it incomplete | Day prepared with the same checks and one-record daily folds; only the GCP day backstop refuses, with the same reasons |
| `quota_day_unrepresentable` (quota preparation over 12,800 rows or 4 MiB; about 4,700 synthetic rows) | Day refused | Quota preparation left empty; windows through the day use the paged quota acquisition |
| `usage_day_unrepresentable` (usage preparation over 4 MiB, 120,000 cells or 100,000 sessions; about 7,000 synthetic sessions) | Day refused | Usage preparation left empty; model windows through the day use the paged usage reduction |
| `usage_window_unrepresentable` (over 120,000 window rows, or one 1,024-page reduction call incomplete) | Scalar fit and model date refused | Paged reduction resumed from its checkpoint until complete; the kernel's own 1,000,000-row window bound decides as in production |
| `quota_window_unrepresentable` (quota fold refused, for example over 4,096 fit fragments) | Scalar fit and model date refused | Paged quota acquisition: 200-row day-aligned pages, one page per step, each phase rewinding with a window-cumulative ordinal, as production steps it |

Nothing under `vendor/` changed except `entry.ts`, the authored facade, which
now re-exports the kernel steps the composition uses (all already in the
facade's closure; `vendor:kernels:check` 10/10). No vendored constant is
patched: the experiment's bounds are bypassed by production's own fallback,
not edited.

### Bounds now in force

| Bound | Value |
|---|---|
| Per-owner memory budget (new) | Default 4,608 MiB (8 GiB task, 6,144 MiB heap); `ANALYTICS_V2_MEMORY_BUDGET_MIB`, 1,024 to 30,720 |
| Day backstop, occurrences | Default and maximum 250,000 (was 20,000); `ANALYTICS_V2_MAX_DAY_OCCURRENCES`, 20,000 to 250,000 |
| Day backstop, record bytes | Default and maximum 256 MiB (was 32 MiB); `ANALYTICS_V2_MAX_DAY_RECORD_MIB`, 32 to 256 |
| Window usage rows | No GCP bound; the kernel's 1,000,000 (production) |
| A-1 read call | About `ANALYTICS_V2_READ_CHUNK_OCCURRENCES` (default 250,000, 10,000 to 2,000,000) by exact counts; a day is never split; 2,000,000 hard ceiling |
| A-1 variants per 200-id batch | 40,000 legacy or correction and 40,000 v1.2 (were 3,200 and 16,384, production's Worker statement bounds) |
| Output owners | 100,000, equal to A-1's roster bound (was 10,000) |

The day backstop's maximum is set by the owner-day evidence digest
(`pin.ts`), one canonical JSON string per day, which V8 caps at 536,870,888
characters (about 470,000 synthetic usage records). Kernel bounds that define
production's result (1,000,000 window rows, 100,000 sessions, the 8 MiB
reduction checkpoint, the quota and plan limits) and method or contract
constants (101-day windows, 70 model dates, 366-day reads, lexical top-200
cells) are unchanged.

### The memory guard and one owner at a time

- `countOwnerOccurrences` (A-1) counts, in SQL, the distinct (observed day,
  occurrence) candidates of the reader's own selection. The reader emits one
  occurrence per candidate and day, so these are its exact row counts; a PG17
  spec compares them with `readOwnerOccurrences` for every owner, stream and
  runtime of the direct-seed corpus and on a 25,000-occurrence v1.2 day.
- `analyticsV2OwnerMemoryEstimate` (`resources.ts`) turns an owner's counts on
  the run's days into a deterministic estimate. An owner over the budget, or
  with a day over one read call's ceiling, gets one `owner` refusal
  `memory_budget` and a `daily` refusal on each queued day it has evidence on;
  those days are blocked, it leaves the fit cohort, it counts as refused on
  every model date, and it is never read. It writes no owner-scoped row, so
  its earlier rows are retained. No heap observation feeds the decision.
- analytics-refresh now reads and computes one effective owner at a time in
  the run's snapshot (the exporting transaction stays open through compute
  with `idle_in_transaction_session_timeout=0`); the owner's occurrences, its
  170 prepared analysis days and an eight-day cache window are released
  before the next owner. A load whose counts differ from its evidence fails
  the run.
- The job refuses to start (`ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT`) unless
  the heap covers the budget plus a reserve of 512 MiB plus 4 KiB per
  read-chunk occurrence.
- `analytics_v2_runs.timings` gains `resources` (the bounds applied) and
  `owners` (per effective owner: usage, quota and session counts, analysis
  usage rows, largest day, estimate, admitted, and the largest sampled heap).
  The stdout receipt carries only content-free aggregates (`memory`).

### Contract and deploy

- Contract `analytics-v2-contract-v0.4`: reason `memory_budget`, which is
  owner-only (never an `analytics_v2_owner_day` reason, so 0059's CHECK is
  unchanged and refuses it there); optional `resources` outputs; the store
  treats an effective owner with an owner refusal as not computed.
- `gcp-fastpath-test-deploy.mjs` sizes the refresh Job at 2 vCPU, 8 GiB,
  `--max-old-space-size=6144` and a 7,200 s task timeout (was 2 vCPU, 4 GiB,
  3,600 s). Cloud Run allows 8 GiB with 2 vCPU; more memory needs 4 vCPU. The
  rehearsal runs the refresh child with the same heap.

## Parity with production's native path

`analytics-v2-test/native-parity.spec.ts` drives the vendored
`advanceStorageEffectiveAnalysis` the way production's `computeEffective`
drives its original paged job (no prepared stores): one step per call, the
checkpoint saved as canonical JSON and parsed back between steps, until
complete. Its D1 reads are stood in for: the owner-authority row is a
constant, and the effective reader serves the same occurrences A-2 receives
with the reader's page contract. The reader itself is A-1's to prove (Q-1
golden rehearsal); this compares the analysis.

| Case (synthetic owner) | Shared reducers | Compared with the oracle | Result |
|---|---|---|---|
| 101-day window over 120,000 usage rows (7 days of 17,200) | `usage_window_unrepresentable` (scalar and model) | Scalar fit today; model dates today, -23, -46, -69 | Equal; all `ready`; 14 fits; native read 635 to 665 pages each |
| Window over 1,024 usage pages, model window over 4,096 entries (13 days of 17,200 over 7,800 sessions) | `usage_window_unrepresentable` | Scalar fit and model date today (paged, resumed) | Equal; `ready`; 20 fits; 1,205 native pages |
| Day over 20,000 occurrences (25,000) | `day_row_limit` | Daily values against a one-record fold of every record; scalar fit and model date today | Equal; `ready`; 8 fits |
| Quota day over its preparation bound (6,000 quota rows) | `quota_day_unrepresentable` | Scalar fit today; model dates today and the dense day | Equal; `ready`; 8 fits |
| Usage day over its preparation bound (8,000 sessions) | `usage_day_unrepresentable` | Scalar fit and model date today | Equal; `ready`; 8 fits |
| Quota fold refused (4,200 fit fragments in one reset pool) | `quota_window_unrepresentable` | Scalar fit and model date today (paged acquisition) | Equal; `ready`; 7 fits |

A seventh case checks the day backstop: a 40,000-occurrence day (over 32 MiB
of records) is prepared at the defaults and refused with the shared
reducers' own reasons at a configured 40,009-occurrence or 32 MiB backstop.

Every case first shows the shared reducers' refusal, then requires the fast
path's scalar analysis (when ready) and model composition to equal the
oracle's, and its fit selection to follow. The first case also pins all 70
model rows and the 14 fits that `compute.spec.ts` pins for A-2's output on
the same corpus.

## Memory model

`ANALYTICS_V2_MEMORY_MODEL` (`analytics-v2-memory-model-v1`) estimates one
owner as: 128 MiB, plus every held occurrence on the run's days (usage
1,700 B, quota 1,400 B, session 1,300 B), plus 2,400 B per usage occurrence on
the 170 analysis days (its prepared usage row and cache item), plus 4,000 B per
occurrence of the owner's largest day (its preparation and evidence digest).

Measured on Node 22.16.0 with the synthetic records of the specs, heap in use
after a forced collection:

| Unit | Measured | Model |
|---|---:|---:|
| Held usage occurrence | 1,329 B | 1,700 B |
| Held quota occurrence | 1,042 B | 1,400 B |
| Held session occurrence | 803 B | 1,300 B |
| Prepared analysis usage row, 1 to 5,000 sessions a day | 1,451 to 2,005 B | 2,400 B |

Whole runs (the three compose owners plus one scenario owner, A-2 in
memory), smallest V8 heap limit that completed against the estimate for the
scenario owner:

| Scenario owner | Usage rows (on analysis days) | Largest day | Failed at heap limit | Completed at heap limit | Estimate |
|---|---:|---:|---:|---:|---:|
| 13 dense days, 600 sessions a day | 223,663 (all) | 17,210 | 608 MiB | 748 MiB | 1,068 MiB |
| One 250,000-occurrence day | 251,975 (all) | 250,000 | not probed | 948 MiB | 2,067 MiB |
| 160 days of 5,000 | 800,000 (all) | 5,025 | 2,048 MiB | 2,548 MiB | 3,281 MiB |
| 400 days of 3,000 | 1,200,000 (510,000) | 3,025 | 1,848 MiB | 2,348 MiB | 3,266 MiB |

In every scenario the estimate was 29% to 118% above the smallest heap limit
that completed, so an admitted owner fits its budget with margin; the cost is
capacity. The measurements use synthetic records. Real v1, v1.1 and v1.2
records, the reader's
transient per candidate (estimated at 4 KiB in the Job's reserve, not
measured) and accumulated outputs of many owners still need measuring on the
Cloud SQL seed. Resident memory ran up to about 1 GB above the heap on the
250,000-occurrence day (encoded record buffers live outside the V8 heap); an
8 GiB task leaves about 2 GiB beyond the 6,144 MiB heap for that.

Time: preparation dominates at about 0.4 to 0.5 ms per usage row on one core
(1,200,000 rows: 477 s; 800,000 rows: 312 to 365 s; 223,663 rows: 95 to
118 s). The scalar fit over a 101-day window of 800,000 rows took 26 to 30 s
and 70 folded model dates 16 s.

## Gates

Run serially or in parallel on this workstation against the PostgreSQL 17
cluster on port 55433 (`PG_TEST_SOCKET`, plus `PG_TEST_TCP_HOST=127.0.0.1`
where named), from `apps/worker` unless a row starts at the repository root.
Node 26.2.0 unless a row names Node 22.16.0. All rows ran on the final code of
this branch; only documentation changed afterwards.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | rc 0 |
| `npm run analytics-v2:check` | 12 files, 118/118 under Node 26.2.0 (322 s) and under Node 22.16.0 (449 s); was 108/108 at `7ef0e144` |
| `npm run vendor:kernels:check` | 10/10; no vendored file changed |
| `npm run postgres:domain:check` with TCP | rc 0. Vitest 12 files, 76/76. node:test 336: 334 pass, 0 fail, 2 skipped (the same two as before: ledger-authority by design; T-2's opt-in Q-1-dump case). Was 327 at `6850ba06`: the refresh spec gained eight cases and the occurrence-source spec one |
| `npm run scripts:check` | rc 0, 967/967 |
| `npm run gcp:fastpath:scripts-check` with TCP | rc 0, 23/23 (deploy 8 includes the new Job size and heap pins) |
| `npm run check` in `cloud-run` (socket) | rc 0; 225 tests: 224 pass, 1 skipped (the opt-in A2 real-PG activation case), as at `6850ba06`; the build context and all 16 build entries, including `dist/analytics-refresh.mjs` |
| Rehearsal (root, socket only) | Exit 1 `gate_failed` on model-days only, as before (127 compared, 119 equal, 91 differences, the OD-12 per-date dates); every other family equal; 168 days published, 2026-04-17 and 2026-04-18 blocked, the same 15 refusals; second run 0 new revisions. The refresh child ran with `--max-old-space-size=6144` and the default resources (budget 4,608 MiB, heap limit 6,192 MiB, required 6,097 MiB), 4 owners computed, 0 refused. Served body 396,337 bytes, sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`; response file `04f7a277a9d8616f…` and preview `b3722cc98b7a82ef…`, unchanged from `7ef0e144` |
| Root `npm run architecture:check` | passed (919 production files, 3,911 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0, 20/20 |
| Default Worker Vitest (`npx vitest run`) | rc 1 only for the pre-existing failure: 174 files, 2,237 tests, 2,236 pass, 1 fail (`test/storage-graph-history-integration.spec.ts` "folds mixed v1 and v1.1 evidence once…", which also fails at the base); no new failure |

Not run: a Docker build, root `npm test` and `npm run check`, the Worker's
full `check` (Wrangler dry runs and `deploy:dry`), and anything on GCP or
Cloudflare.

## Divergences from production, and what this does not prove

- **Worker-only refusals.** Production's cache lane refuses a cache day whose
  progress envelope exceeds 1.9 MB or 100,000 sessions
  (`checkpoint_size_exceeded`), leaves a cache day unbuilt when its effective
  dependency vector exceeds 30,000 rows or 4 MiB, and its reader stops at 3,200
  variants per page. These are D1 and Worker limits; GCP computes those days
  with the same kernel reducer instead of refusing them. This is a divergence
  by design (OD-11), proven only against the kernels, not against a production
  publication.
- **Fold or page.** Like production with prepared or shared features, GCP
  folds a model window when every day is prepared and the window is
  representable; production's original paged job pages it. The kernel itself
  documents that the fold does not apply the 8 MiB checkpoint bound; the specs
  found the two equal wherever both ran.
- **The reader at production volumes.** Dense reads are proven on synthetic
  PostgreSQL rows only (25,000 v1.2 occurrences on one day). No production
  owner was read; OD-4 remains the owner's.
- **The largest real owner.** The plan's figure is about 2.52 million records.
  Its estimate is roughly 4.2 GiB if almost all of them predate the 170
  analysis days and roughly 10 GiB if almost all fall within them, so the
  default 8 GiB task (4,608 MiB budget) admits it only at the low end and
  otherwise refuses it with `memory_budget`. A 16 GiB task with 4 vCPU,
  `--max-old-space-size=12288` and `ANALYTICS_V2_MEMORY_BUDGET_MIB=10752` fits
  the reserve and admits it at the high end, by this model; that profile was
  not run. The model is calibrated on synthetic records and must be
  recalibrated on the Cloud SQL seed.
- **Time.** One owner is single-threaded. Over an unrepresentable
  223,600-row window the fast path and the oracle together took 148 s for one
  scalar fit and one model date; each of 70 such model dates pages the whole
  window. A production cold run of a dense owner is not measured.

## Remaining gates

- Choose the task profile for the largest real owner, and recalibrate the
  memory model on the Cloud SQL seed.
- A dense oracle through the real D1 effective reader (HX-4 sealed-SQLite
  adapter, Node 24.10 or later), if reader parity at volume is required.
- Owner acceptance of the Worker-only cache divergences above.
- (Later on 2026-10-01: the dense-owner parity run, the rehearsal's exit 0
  under OD-12 and the refresh Job profiles are in the
  [dense-owner parity receipt](./2026-10-01-gcp-dense-owner-parity.md).)
- Image build, test-project deploy at the new size and a measured cold run;
  none were run for this receipt.
