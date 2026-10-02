---
title: GCP E-QUIESCE read-only pre-fence quiescence check
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP E-QUIESCE read-only pre-fence quiescence check

This is a 2026-10-02 receipt for stream E-QUIESCE on branch
`claude/gcp-fp-e-quiesce`, built on `c80f99b9` (`claude/gcp-fastpath-final`
at the C-MAINT merge). The code is one commit, `698d04c8`; the commit that adds
this receipt also corrects one sentence of the fast-path plan. It records
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
reports counts, and a verdict of `clear`, `blocked` or `not-evaluated`; each one
names the refusal it stands for and whether that refusal exists in code at this
commit (`refusals[].implemented`).

| Check | Reads | Refusal it stands for | In code |
|---|---|---|---|
| `participants-quiescent` | ingestion | PT-3 `CUTOVER_PARTICIPANT_ERASURE_PENDING`: a participant that is not `active`, or still has a `deletion_session_id` | yes |
| `deletion-digest-intersection` | ingestion, ledger | PT-2-lite and PT-3 `CUTOVER_ERASED_PARTICIPANT_PRESENT`: a participant whose deletion digest is a recorded tombstone | yes |
| `owner-links-erased` | ingestion | PT-8 erasure quiescence: a v1.1 owner link already `erased` | no |
| `pending-quarantine-registrations` | ingestion | PT-4 and PT-8: any `pending_quarantine_objects` row, split `registered` and `deleting` | no |
| `correction-runtime` | ingestion | PT-8 `CUTOVER_CORRECTION_RUNTIME_ACTIVE`: the runtime row must be the one `staged` row, with no correction facts or history | no |
| `pending-erasure-jobs` | ledger | PT-8 pending jobs and HX-6 `pendingErasureJobs`: `storage_erasure_jobs` in `pending` | no |
| `analytics-delivery` | ingestion, analytics | HX-6 `cursorEqualsJournalMax` and the operator's `--analytics-drain-complete` attestation to EP-8 | no |

A check whose input is absent is `not-evaluated`, never `clear`: a missing
input is not zero. The verdict is `blocked` if any check blocks, else
`incomplete` if any check was not evaluated, else `quiescent`. Exit status is 0,
2 and 3 for those, and 1 for an error.

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

The other five checks implement the PT-8, PT-4 and HX-6 briefs; none of those
refusals is in code yet. When they land, flip `implemented` and have them share
these predicates, including `CORRECTION_RUNTIME_STAGED_STATE`.

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

Counts, closed state names, one timestamp (the oldest quarantine registration)
and opaque 16-hex references: a purpose-separated sha256 prefix of an id, never
the id or a ledger digest. At most 25 references per check, with a truncation
flag. A participant that is both mid-erasure and tombstoned carries the same
reference in both checks. No participant id, tombstone digest, source id,
object key, path or secret is printed; a source file is identified by its
sha256 and, when sealed, the seal id.

## Acceptance evidence

Run from `apps/worker` at `698d04c8`, Node 26.2.0, no `PG_TEST_*` variables:

| Gate | Result |
|---|---|
| `node --test ./scripts/cutover-quiescence-check.check.mjs` | 24 of 24 |
| `npm run postgres:cutover-seal:check` (seal, fence, projections, PT-3 and this check) | 57 of 57 (was 32 of 32; this stream adds 25) |
| `node --test ./scripts/storage-journal-single-producer.check.mjs` | 2 of 2 (the new script names the journal in a `SELECT` only) |
| `npm run gcp:fastpath:scripts-check` | 65 pass, 3 skipped (PostgreSQL cases, no `PG_TEST_*`) |
| `npm run test:preflight`, `npm run architecture:check` (repository root) | pass |

What the 24 checks prove:

- **Every refusal case, on forged copies of the synthetic sources.** Four
  participant shapes (deleting with its fence, deleting with a NULL fence,
  active with a fence left on it, a state outside the D1 CHECK); a tombstone
  for an active participant; a participant both deleting and tombstoned; a
  malformed ledger digest; an erased owner link; two quarantine registrations
  (`registered` and `deleting`); the oracle's active correction runtime, a
  staged runtime holding a fact and its history, and a missing runtime row;
  one and several pending erasure jobs; and delivery behind, ahead, absent and
  with a foreign cursor.
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

Six deliberate breaks of the implementation each failed at least one check:
PT-3's predicate without its fence disjunct, the correction check ignoring
facts, the delivery check ignoring a cursor ahead of the journal, the
intersection dropping its references, pending jobs never blocking, and
quarantine blocking only on `deleting`.

Not run: the PostgreSQL specs that import the two edited modules
(`postgres-identity-authority-transfer.spec.mjs`,
`cutover-source-seal-rehearsal.spec.mjs`), because they create objects under
their own prefix rather than this stream's. The edit to PT-3 is a string
extraction whose interpolated SQL is the original text, and the offline PT-3
check (every pre-write refusal, plus the clean path up to the handle) and the
projections check pass.

## Findings for the lead

1. **The oracle's correction runtime is `active`.** The unmodified Q-1 corpus
   reads `correction-runtime` blocked: its runtime row is `active`, not the
   `staged` that D1 0006 seeds. The fixtures restore the seeded value (dropping
   the only trigger that refuses it) for the clean case. Whether production is
   `active` is unknown here. If it is, PT-8 as specified refuses the cutover
   with `CUTOVER_CORRECTION_RUNTIME_ACTIVE`. One owner-run read of the
   ingestion statement answers it, so run it before E-PT8 is built.
2. **A live source is rarely `quiescent`.** In-flight uploads register
   quarantine objects and the delivery cursor lags the journal, so those two
   checks can block on a healthy live source. Read their counts: a `registered`
   row with a recent oldest timestamp is in flight; `deleting` is a
   reconciliation lease the fenced Worker cannot finish. The checks that must be
   zero before the fence is applied are `participants-quiescent`,
   `deletion-digest-intersection` and `pending-erasure-jobs`; run the whole set
   again on the sealed source.
3. **Merge and plan notes.** `apps/worker/package.json` line 32
   (`postgres:cutover-seal:check`) is the only line this stream changes there,
   and that file is edited by several streams, so expect a textual merge at
   neighbouring lines. The plan's PT-2-lite row (`docs/plans/2026-10-01-gcp-fastpath.md`, line 521)
   said the pre-fence check was not built; this commit corrects that sentence.
   The W2-SEAL and wave-2 integration receipts keep their own dated statements.
   CUTOVER-CHECKLIST item E-QUIESCE and the H.2 fence step are the lead's to
   update: the check is the E-QUIESCE query, and its `participants-quiescent`,
   `deletion-digest-intersection` and `pending-erasure-jobs` checks belong
   before the fence.

## Open issues and owner inputs

- The statements and Wrangler's `--json` envelope are unverified against the
  provider. Each ingestion statement is one `SELECT` of about twenty `UNION ALL`
  arms; whether D1 accepts a compound `SELECT` that size is unknown (the seal's
  own aggregate batches are of 16 and equally unverified). The merge fallback
  above covers a refusal. A missing table fails the whole statement and no
  verdict is given.
- Not covered, by design: PT-3's other pre-write refusals (the identity-link
  pin, the public-source bootstrap, the accountless chain, column and counter
  closure), which are not erasure state; and HX-6's other drain checks, the
  catch-up queue rows and the cache-retention days.
- The delivery check reads one source, the ingestion's singleton, against the
  analytics cursor row of the same `source_id`. A source with no cursor row has
  delivered nothing, as the Worker's own delivery trigger reads it.
- This stream's instructions asked for the commit trailer
  `Co-Authored-By: Claude Opus 5.5`; the session's attribution rule gives
  `Claude Sonnet 5.5`, which the code commit carries. Amend if the line must
  differ.
