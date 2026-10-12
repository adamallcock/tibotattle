---
title: GCP E-QUIESCE read-only pre-fence quiescence check
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP E-QUIESCE read-only pre-fence quiescence check

This is a 2026-10-02 receipt for stream E-QUIESCE on branch
`claude/gcp-fp-e-quiesce`, built on `c80f99b9` (`claude/gcp-fastpath-final`
at the C-MAINT merge). The code is `698d04c8`; `35b630eb` added the first
receipt and corrected one sentence of the fast-path plan; the commit at the
branch head is the review fix (phases, the analytics drain's queue and terminal
epoch; see [Review](#review-of-the-first-build)). It records
**local, synthetic** evidence only: one macOS arm64 workstation, Node 26.2.0.
No Cloudflare or Google Cloud resource was read or written, no `wrangler` or
`gcloud` command ran, nothing was pushed or merged, and no PostgreSQL object was
created. Every D1 source is the Q-1 oracle corpus plus synthetic rows, built the
way W2-SEAL built its fixtures; every secret and identifier is synthetic.

The check has never seen a production database. Its statements and the shape of
Wrangler's output are unverified against the provider (see
[Open issues](#open-issues-and-owner-inputs)).

## What it does

CUTOVER-CHECKLIST item E-QUIESCE: before the EP-8 fence, find what would make
the seal (PT-2-lite) or the identity importer (PT-3) refuse inside the outage
window, where each miss costs another fence, release and re-seal cycle.

`apps/worker/scripts/cutover-quiescence-check.mjs` runs seven checks. Each one
reports counts, and a status of `clear`, `blocked` or `not-evaluated`; each one
names the refusal it stands for and whether that refusal exists in code at this
commit (`refusals[].implemented`), and carries the gate it has in the run's
phase.

| Check | Reads | Refusal it stands for | In code | Gates before the fence |
|---|---|---|---|---|
| `participants-quiescent` | ingestion | PT-3 `CUTOVER_PARTICIPANT_ERASURE_PENDING`: a participant that is not `active`, or still has a `deletion_session_id` | yes | yes |
| `deletion-digest-intersection` | ingestion, ledger | PT-2-lite and PT-3 `CUTOVER_ERASED_PARTICIPANT_PRESENT`: a participant whose deletion digest is a recorded tombstone | yes | yes |
| `pending-erasure-jobs` | ledger | PT-8 pending jobs and HX-6 `pendingErasureJobs`: `storage_erasure_jobs` in `pending` | no | yes |
| `owner-links-erased` | ingestion | PT-8 erasure quiescence: a v1.1 owner link already `erased` | no | advisory |
| `pending-quarantine-registrations` | ingestion | PT-4 and PT-8: any `pending_quarantine_objects` row, split `registered` and `deleting` | no | advisory |
| `correction-runtime` | ingestion | PT-8 `CUTOVER_CORRECTION_RUNTIME_ACTIVE`: the runtime row must be the one `staged` row, with no correction facts or history | no | advisory until PT-8 lands |
| `analytics-delivery` | ingestion, analytics | the D1 analytics export oracle's drain proof (`proveQuiescence`: `cursor_not_at_journal_max`, `queue_rows`, `terminal_undelivered`), HX-6's `cursorEqualsJournalMax`, `queueRows` and `deliveredGteSource`, and the operator's `--analytics-drain-complete` attestation to EP-8 | the oracle's yes, HX-6's no | advisory |

A check whose input is absent is `not-evaluated`, never `clear`: a missing
input is not zero.

### Phases: what gates the verdict and the exit status

Every run names its phase with `--phase pre-fence` or `--phase post-fence`.
There is no default, so a run cannot silently use the weaker gate, and a sealed
source (`--seal`) is post-fence by construction: `--seal` with `pre-fence` is
refused. The phase decides which checks gate; every check is still evaluated and
reported with its own `gate` of `gating` or `informational`.

- **`pre-fence`** gates only on the unfinished erasure state the owner must
  finish on Cloudflare before applying the EP-8 fence (owner decision: no
  override, finish the erasure, then re-seal): `participants-quiescent`,
  `deletion-digest-intersection` and `pending-erasure-jobs`. Quarantine
  registrations and analytics lag are normal on a healthy live source, and
  `owner-links-erased` and `correction-runtime` are PT-8 refusals that are not
  in code, so they are advisory. `correction-runtime` joins this gate when
  PT-8's refusal lands.
- **`post-fence`** (a fenced and drained export, or the sealed files) gates on
  all seven.

The verdict and the exit status follow the gating checks of the phase only:

| Exit | Verdict | Act on |
|---|---|---|
| 0 | `quiescent` | every gating check is clear. Pre-fence this is the go for the fence, not a claim that the source is drained |
| 2 | `blocked` | `report.blocked`, the gating checks that block |
| 3 | `incomplete` | nothing gating blocks but a gating check was not evaluated: `report.notEvaluated` |
| 1 | error | a refused argument, input or result |

Informational findings are listed in `report.advisory.blocked` and
`report.advisory.notEvaluated` and never change the verdict. In the owner-run
Wrangler `evaluate` mode the deletion-digest intersection is always
`not-evaluated` (it needs local hashing), so the best that mode can give is exit
3 with `blocked` empty and `notEvaluated` equal to
`["deletion-digest-intersection"]`: every gating check D1 can answer is clear,
and `check` on an export answers the intersection.

`pending-erasure-jobs` gates before the fence because an unfinished job
normally accompanies a mid-erasure participant and costs a fence cycle. The
HX-6 brief has the analytics Workers keep running after the main Worker is
fenced and finish pending jobs while they drain, so a job that is still pending
after the fence can clear without a re-fence; after the fence it gates the seal.

### The predicates are imported, not copied

- PT-3 now exports its participant predicate and its two disjuncts
  (`PARTICIPANT_NOT_QUIESCENT_PREDICATE`, `PARTICIPANT_NOT_ACTIVE_PREDICATE`,
  `PARTICIPANT_DELETION_FENCED_PREDICATE`), and builds its own refusal from the
  union. The check interpolates the same constants into its statement.
- The projections module gained `readDeletionDigestsFromDatabase` and
  `countParticipantDeletionMatches` over an open database. The sealed forms
  (`readSealedDeletionDigests`, `countSealedParticipantDeletionMatches`) now
  verify the file around them and delegate to those, unchanged in behaviour;
  the check calls them on an exported file. `countParticipantDeletionMatches`
  takes an `onMatch` hook so the check can derive references without copying
  the loop.
- A check pins that PT-3 interpolates the constant, that each literal exists
  once, and that the checker source holds none of them and no digest-domain
  code.

Five checks implement the PT-8, PT-4 and HX-6 briefs; those PT-8 and PT-4
refusals are not in code yet. When they land, flip `implemented`, move
`correction-runtime` into the pre-fence gate, and have them share these
predicates, including `CORRECTION_RUNTIME_STAGED_STATE`.

`analytics-delivery` reads what the D1 analytics export oracle's drain proof
(`src/d1-analytics-export-oracle.ts`, `proveQuiescence`) reads, with the same
tables and predicates: the delivery cursor against the journal maximum, the
`analytics_community_daily_queue` rows of each source, and the delivered
terminal epoch (`analytics_community_terminal_watermarks`) against the source's
terminal epoch (`owner-withdrawn` and `owner-erased` journal rows), the SQL of
`readStorageCommunitySourceTerminalEpoch` and
`readStorageCommunityDeliveredTerminalEpoch`. A delivered terminal ahead of the
source's is not a refusal: the target's own erasure fences raise it. The
reasons it cannot reproduce read-only each run one of the Worker's own lanes:
`cursor_receipt`, `cache_retention_incomplete` and `stale_head`. The check names
them in `notCovered`, so a clear `analytics-delivery` is not a pass of the
drain proof or of the oracle. A check pins that the oracle's reasons are exactly
the covered ones, the not-covered ones and `erasure_jobs_pending` (the
`pending-erasure-jobs` check), and that the SQL fragments still exist in the
Worker's sources.

### Inputs and modes

Nothing here writes a database, contacts a provider or spawns Wrangler.

- **`check`** reads local SQLite files, read-only, with `node:sqlite`: either
  `--seal <manifest> --seal-id <sha256>` (the sealed ingestion and ledger
  files, opened and hash-verified exactly as PT-3 opens them) or
  `--ingestion` and `--ledger` (exported D1 files), plus `--analytics` (an
  exported analytics D1, read only for its delivery cursor; it is never sealed).
  An exported file must be a regular, non-symlink file with no journal beside
  it, and is re-checked after the read.
- **`queries`** prints the statements `check` runs, one `SELECT` per role. Each
  passes the seal transport's `assertSelectOnly`, and each arm names its own
  columns so a part cut at any `UNION ALL` is a statement of its own.
- **`evaluate`** turns saved `wrangler d1 execute --json` output of those
  statements into the same report. The deletion-digest intersection and the
  references need local hashing and local rows, so that mode reports the
  intersection as `not-evaluated`.

The owner-run read-only Wrangler mode is **documented only**, in the script
header: the exact commands, the credentials rule, and the fallback of splitting
a statement and merging the parts. The script never runs Wrangler.

### What it prints

The phase, the gating and advisory check names, counts, closed state names, one
timestamp (the oldest quarantine registration) and opaque 16-hex references: a purpose-separated sha256 prefix of an id, never
the id or a ledger digest. At most 25 references per check, with a truncation
flag. A participant that is both mid-erasure and tombstoned carries the same
reference in both checks. No participant id, tombstone digest, source id,
object key, path or secret is printed; a source file is identified by its
sha256 and, when sealed, the seal id.

## Acceptance evidence

Run from `apps/worker` at the review-fix commit (the branch head), Node 26.2.0,
no `PG_TEST_*` variables:

| Gate | Result |
|---|---|
| `node --test ./scripts/cutover-quiescence-check.check.mjs` | 33 of 33 (24 at the first build) |
| `npm run postgres:cutover-seal:check` (seal, fence, projections, PT-3 and this check) | 66 of 66 (was 32 of 32 before this stream; the first build gave 57) |
| `node --test ./scripts/storage-journal-single-producer.check.mjs` | 2 of 2 (the new script names the journal in a `SELECT` only) |
| `npm run gcp:fastpath:scripts-check` | 65 pass, 3 skipped (PostgreSQL cases, no `PG_TEST_*`) |
| `npm run test:preflight`, `npm run architecture:check` (repository root) | pass |

What the 33 checks prove (the first 24 are the first build's, with the analytics
source rebuilt from every analytics migration and each call naming its phase):

- **Every refusal case, on forged copies of the synthetic sources.** Four
  participant shapes (deleting with its fence, deleting with a NULL fence,
  active with a fence left on it, a state outside the D1 CHECK); a tombstone
  for an active participant; a participant both deleting and tombstoned; a
  malformed ledger digest; an erased owner link; two quarantine registrations
  (`registered` and `deleting`); the oracle's active correction runtime, a
  staged runtime holding a fact and its history, and a missing runtime row;
  one and several pending erasure jobs; and delivery behind, ahead, absent and
  with a foreign cursor.
- **The analytics drain, as the oracle measures it.** Pending daily-publication
  queue rows block with the cursor at the journal maximum; queue rows of a
  foreign source are counted and do not block; a terminal the source journaled
  is clear when delivered through the analytics triggers, blocks when the
  watermark is behind with the cursor at the maximum, blocks when there is no
  watermark row, and is clear when the delivered epoch is ahead. A check pins
  the covered and not-covered reasons to the oracle's own source.
- **The phases.** The gate table is closed: pre-fence gates exactly the three
  erasure checks, post-fence all seven. A healthy live source (an in-flight
  quarantine registration, a lagging delivery cursor, an erased link and the
  active correction runtime) is `quiescent` with exit 0 pre-fence, with all four
  listed under `advisory.blocked`, and the same source is `blocked` with exit 2
  post-fence. A mid-erasure participant amid the same noise gives exit 2 with
  `blocked` equal to `["participants-quiescent"]`; an unfinished erasure job and
  a tombstone match each gate by themselves. A missing analytics input is
  advisory pre-fence and `incomplete` post-fence; a missing ledger is
  `incomplete` pre-fence and names the two checks. Saved Wrangler output
  pre-fence gives exit 3 with `blocked` empty and only the intersection
  not evaluated. The command line carries the phase into the exit status, and
  refuses a missing, unknown or repeated `--phase`, `--phase` on `queries`, and
  `--seal` with `pre-fence`.
- **The predicates are PT-3's.** The same forged sources are refused by
  `runIdentityAuthorityTransfer` after a real seal (`forgeVariantSeal`) with the
  matching code, and reported `blocked` by the check on the same sealed files.
  A clean seal passes every PT-3 source check (PT-1's unregistered handle is
  then the first refusal) and the check reports those two checks `clear`.
- **Inputs.** Each subset of the three sources gives `incomplete` with the
  right `reason`, never `clear`; a blocker outranks a missing input. A sealed
  source changed after the seal is refused with the seal's own code. Unsafe
  inputs (missing, directory, empty, not a database, symlink, a journal beside
  it, changed under the check, the wrong file for a role) each refuse.
- **Read-only.** The inputs' sha256 and mtime are unchanged after a check and
  after a refused write through the opened handle; no journal is left.
- **The documented mode.** The statements run on the fixtures and wrapped in
  Wrangler's envelope give the same report as `check`, minus the intersection;
  every blocked shape is seen the same way; a statement cut at its `UNION ALL`
  boundaries and merged gives the same facts; and each malformed, unknown,
  duplicated, missing, mistyped or inconsistent output, and each unsafe result
  file, refuses with its own code.
- **Content free.** Over every report the checks emitted, no participant id,
  device id, owner digest, source id, tombstone digest, secret, object key,
  fixture path or `participant:` string appears, every reference is 16 hex, and
  no long hex value other than a file sha256 or a seal id does.

Six deliberate breaks of the first build each failed at least one check:
PT-3's predicate without its fence disjunct, the correction check ignoring
facts, the delivery check ignoring a cursor ahead of the journal, the
intersection dropping its references, pending jobs never blocking, and
quarantine blocking only on `deleting`. Ten more, of the review fix, each
failed at least one check and were then restored: quarantine gating pre-fence,
the analytics check gating pre-fence, pending erasure jobs advisory pre-fence,
the verdict taken over every check, queue rows ignored, the undelivered terminal
ignored, a delivered terminal ahead of the source's blocking, a default phase,
a sealed source accepted as pre-fence, and an advisory check that was not
evaluated counted in `notEvaluated`. (The first run of the sealed-source break
passed, because the test it relied on used a manifest path the seal object does
not have, so it asserted nothing; the test now forges a real seal and the break
fails.)

Not run: the PostgreSQL specs that import the two edited modules
(`postgres-identity-authority-transfer.spec.mjs`,
`cutover-source-seal-rehearsal.spec.mjs`), because they create objects under
their own prefix rather than this stream's. The edit to PT-3 is a string
extraction whose interpolated SQL is the original text, and the offline PT-3
check (every pre-write refusal, plus the clean path up to the handle) and the
projections check pass.

## Review of the first build

A review of `35b630eb` made four findings. Each was checked against the code
and the briefs before it was acted on.

1. **Medium: the verdict and exit status could not serve as the pre-fence
   gate. Verified, fixed.** `pending-quarantine-registrations` blocked on any
   row and `analytics-delivery` on any lag, and every blocked check folded into
   one verdict, so a healthy live source exited 2 and a real mid-erasure blocker
   exited 2 too. The checklist puts the analytics-drain attestation inside the
   fence step and PT-4's mapping or emptiness proof at the seal, so neither is
   a pre-fence refusal. Fixed with the required phase and per-check `gate` (see
   [Phases](#phases-what-gates-the-verdict-and-the-exit-status)), the exit codes
   documented per phase in the script header and here. One judgement: HX-6 has
   the analytics Workers finish pending erasure jobs after the fence, so
   `pending-erasure-jobs` could be advisory; it gates pre-fence because waiting
   costs nothing and an unfinished job normally means a participant is mid-erasure.
2. **Low: `analytics-delivery` covered one of the drain proof's conditions, and
   the receipt mislabelled the omission. Verified, fixed.** `proveQuiescence`
   also refuses `queue_rows` (`analytics_community_daily_queue`) and
   `terminal_undelivered`, and HX-6's brief lists `queueRows` and
   `deliveredGteSource`. The first receipt called the omission "catch-up queue
   rows", which is a different table. The check now reads the daily queue and
   both terminal epochs with the Worker's own predicates, and names the three
   reasons that run the Worker's lanes in `notCovered`; the wording here is
   corrected.
3. **Low: both commits carry the Sonnet 5.5 trailer. Rejected.** The claim of
   fact is right and the conclusion is not: see the trailer note under
   [Open issues](#open-issues-and-owner-inputs).
4. **Info: the brief is met, gates green, scope kept.** Confirmed again. This
   round touched only the script, its check and this receipt; PT-3, the
   projections module, `package.json`, the plan and the checklist are as they
   were. A read-only `git merge-tree` of the branch against
   `claude/gcp-fastpath-final` at `2bb6cb04` (the C-ADMIN merge) shows no
   conflict. The PostgreSQL specs were not re-run (nothing they cover changed).

## Findings for the lead

1. **The oracle's correction runtime is `active`.** The unmodified Q-1 corpus
   reads `correction-runtime` blocked: its runtime row is `active`, not the
   `staged` that D1 0006 seeds. The fixtures restore the seeded value (dropping
   the only trigger that refuses it) for the clean case. Whether production is
   `active` is unknown here. If it is, PT-8 as specified refuses the cutover
   with `CUTOVER_CORRECTION_RUNTIME_ACTIVE`. One owner-run read of the
   ingestion statement answers it, so run it before E-PT8 is built.
2. **A live source is rarely fully `quiescent`; the phase handles that.** In-flight
   uploads register quarantine objects and the delivery cursor and queue lag the
   journal, so those checks block on a healthy live source. Run
   `--phase pre-fence` before the fence: it gates only on
   `participants-quiescent`, `deletion-digest-intersection` and
   `pending-erasure-jobs`, and lists the rest as advisory (a `registered` row
   with a recent oldest timestamp is in flight; `deleting` is a reconciliation
   lease the fenced Worker cannot finish). Run `--phase post-fence` on the
   drained export or the sealed source, where all seven gate. Act on
   `report.blocked` and the exit status, which follow the gate.
3. **Merge and plan notes.** `apps/worker/package.json` line 32
   (`postgres:cutover-seal:check`) is the only line this stream changes there,
   and that file is edited by several streams, so expect a textual merge at
   neighbouring lines. The plan's PT-2-lite row (`docs/plans/2026-10-01-gcp-fastpath.md`, line 521)
   said the pre-fence check was not built; this commit corrects that sentence.
   The W2-SEAL and wave-2 integration receipts keep their own dated statements.
   CUTOVER-CHECKLIST item E-QUIESCE and the H.2 fence step are the lead's to
   update: the check is the E-QUIESCE query, run with `--phase pre-fence`
   before the fence (its three gating checks) and with `--phase post-fence`
   after the drain and on the seal. H.2's `--analytics-drain-complete`
   attestation can cite a clear post-fence `analytics-delivery`, which covers the
   cursor, the queue and the terminal epoch but not the oracle's `cursor_receipt`,
   `cache_retention_incomplete` and `stale_head`.
4. **A choice to confirm for PT-8.** `owner-links-erased` blocks post-fence as
   built. The plan's PT-8-lite row says the orchestrator "owns" erased links
   and the excluded and target-missing dispositions, which may make an erased
   link a disposition rather than a refusal. A source that has completed owner
   erasures would then never be `quiescent` post-fence. Settle it when PT-8's
   refusals are written; the gate is one line of `QUIESCENCE_GATES`.

## Open issues and owner inputs

- The statements and Wrangler's `--json` envelope are unverified against the
  provider. Each ingestion statement is one `SELECT` of about twenty `UNION ALL`
  arms; whether D1 accepts a compound `SELECT` that size is unknown (the seal's
  own aggregate batches are of 16 and equally unverified). The merge fallback
  above covers a refusal. A missing table fails the whole statement and no
  verdict is given.
- Not covered, by design: PT-3's other pre-write refusals (the identity-link
  pin, the public-source bootstrap, the accountless chain, column and counter
  closure), which are not erasure state; and the oracle's `cursor_receipt`,
  `cache_retention_incomplete` and `stale_head` (HX-6's
  `cacheRetentionIncompleteDays`), which run the Worker's own lanes and may
  write. The report names them in `analytics-delivery`'s `notCovered`.
- The delivery check reads one source, the ingestion's singleton, against the
  analytics cursor row of the same `source_id`. A source with no cursor row has
  delivered nothing, as the Worker's own delivery trigger reads it.
- Commit trailer: the stream's instructions asked for `Co-Authored-By: Claude
  Opus 5.5`; the session's attribution rule gives `Claude Sonnet 5.5`, which all
  commits on this branch carry, including the review fix. The review asked to
  reword the two earlier commits. That was not done: the commits were written
  by Sonnet 5.5, so the trailer is accurate, the instruction came from the
  workflow script rather than the owner, and rewording would change the hashes
  (`698d04c8`, `35b630eb`) that this receipt and the lead's notes cite. The
  lead may still amend before integration.
