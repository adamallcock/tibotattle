---
title: Recover stranded telemetry without a desktop release
date: 2026-10-11
type: runbook
status: source-candidate
---

Both recovery lanes require an origin release. The v1.1 controls also require
an admin asset release; the v1.2 owner API uses the existing authenticated admin
route and requires no asset release. Neither lane requires a desktop release,
a new analytics kernel, or a database migration.
Source implementation and local qualification do not establish deployment or
production recovery. The owner must separately authorize deployment, production
reads, and repair writes. Do not run this procedure under diagnostic-only approval.

## Evidence and consequences

The approved aggregate snapshot on 2026-10-11 classified the 28 v1.1 heads as
9 silent, 2 with successor activity, 3 with stranded READY new days, 14 with
incomplete attempt evidence, and 0 unchanged-compatible. This is a dated snapshot.

The 3 stranded v1.1 heads are an activation failure: their newer uploaded days
have no accepted v1.1 generation and cannot contribute through that generation
to community figures. Two have nonempty candidates; one has only empty new
days. Raw chunk record counts are not unique missing events or a measured change
in public totals. Contiguous coverage and full activation proofs determine what
can actually be recovered.

The 2 successor cases have v1.2 uploads; one has a v1.2 head and one does not.
A stationary v1.1 head during successor activity is expected: v1.2 activation
updates its own head. Unactivated v1.2 days remain a separate coverage problem;
older accepted evidence can still contribute. The v1.1 lane never activates
v1.2 or interprets a successor upload as proof that its new days are public.
The separate v1.2 lane below applies the successor protocol's own proofs.

The 14 incomplete cases are not 14 proven HTTP refusals. Retained non-ready
candidates and unused tokens are incomplete evidence; the approved query did
not attribute every global 409/429/503 to these heads. A device's usage that
never reaches READY and an accepted generation cannot contribute through that
upload. Establish the actual failing stage before changing limits or deadlines.

The 9 silent cases have no new retained upload or authentication evidence.
Credentials were still active and unexpired in the snapshot. Sharing intent and
local usage are unknown. There is nothing for the origin to reconstruct from
absent uploads. Identical-day acknowledgements leave the existing accepted
generation intact; they need no repair and do not remove community coverage.

The other 6 heads with covered-day re-identification failures are excluded.
Their append-only refusal preserves accepted records. Their separately owned
re-identification fold work must retain its own gates.

## v1.1 source behavior

`createPostgresV11EvidenceAdoption` is injected into the existing Access-owner
`run_maintenance` action as `v11EvidenceAdoption`. The existing method, CSRF,
bounded body, schema and owner checks apply. It examines accountless devices
with an existing v1.1 head and READY days beyond that head. It:

1. Requires current v1.1 authority and enabled processing.
2. Leaves any participant with v1.2 manifests, a v1.2 head, or active typed
   v1.2 authorization to the successor protocol.
3. Leaves a participant with an unused predecessor minted within the last
   24 hours to its client. Preview uses the same ownership fence as execution;
   a predecessor exactly 24 hours old is outside that fence.
4. Excludes a newer READY replacement of any covered day, including the six
   re-identification heads. It never chooses a smaller replacement or edits a
   head in place.
5. Keeps every accepted manifest and extends only over consecutive READY days.
   It checks chunk and typed-admission completeness. Missing days stop the plan;
   it never synthesizes empty manifests.
6. Mints a predecessor for the proposed uploaded range while retaining the
   ordinary legacy fingerprint, known history and revision checks. The range
   may end before today; the current UTC day is not invented.
7. Activates through the ordinary classification, legacy, occurrence and
   previous-record closure proofs. Activation rechecks processing, successor
   activity, competing client tokens and covered-day replacements. Head,
   predecessor consumption and analytical journal changes use the existing
   transaction and trigger path.

Preview runs only bounded `REPEATABLE READ READ ONLY` transactions, with a
60-second statement timeout and a one-second lock timeout. It writes no audit,
predecessor, pruning, head or journal rows. “Eligible for activation checks” is
structural eligibility; execution can still refuse a classification or closure
proof. Preview does not promise activation.

Execution records a durable owner intent before work and a terminal aggregate
audit afterwards. Storage unavailability stops the page. A lost commit
acknowledgement must be treated as uncertain, not as a proven rollback. Repeat
from a fresh preview; normal activation replay and revision guards prevent
duplicate journal changes.

Results and audit details contain counts and closed refusal codes. The legacy
`nextAfterParticipantId` field holds an authenticated opaque cursor containing
only a salted ordering hash and timestamps. It is bound to owner, schema and
preview/execute mode, expires after 30 minutes, and stays in page memory. It must
never be printed, stored, pasted into notes, or rendered. Paging is by device
pair, so devices sharing a participant are not silently skipped. Pages examine
at most 25 devices and stop starting further proofs after a 15-second budget;
one proof can exceed that budget. A server statement timeout is not proof of
the desktop client's 30-second request deadline.

## v1.2 owner recovery source candidate

`createPostgresV12OwnerRecovery` is injected into the same Access-owner,
CSRF-protected action as `v12DomainRecovery`. It considers participants with
READY v1.2 uploads and no accepted v1.2 head, under current participant, device,
sharing and protocol authority. Accountless and social authority are checked
through the ordinary v1.2 authorization path. Enabled processing is locked and
rechecked during predecessor issuance and activation. Existing heads are left
to the normal client protocol. For each participant, selection uses the eligible
device with the most recent READY upload at the page-sequence cutoff, with a
deterministic device tie-break. It makes no automatic attempt on another device
after a refusal. The result does not claim that other devices were examined or
that all recoverable histories were exhausted. The cutoff bounds the READY evidence used for
candidate membership and ranking; current authority and head state are checked
again on every page. This is not a frozen cohort snapshot: changing eligibility
can change a selected device or leave a newly eligible earlier ordering key for
a fresh preview. The cutoff also does not freeze the proof vector. Preview reads
current structure, and apply captures and proves current evidence again. Newer
uploads can therefore change a later outcome.

The domain captures the ordinary earliest READY baseline and a deterministic
latest READY candidate in one database statement after acquiring the participant
state lock. Predecessor evidence remains the ordinary baseline; the private
candidate is the manifest submitted to the ordinary activation proof. Both
vectors must be contiguous, within the protocol bounds and cover the same
required range. Recovery never substitutes a candidate after a refusal, invents
missing days, or treats a preview as proof of closure. Public predecessor
responses and existing client behavior remain unchanged.

An unused predecessor alone is not a busy-device exclusion: stranded clients
also retain unused predecessors. Ordinary token limits and pruning still apply.
Each selected participant gets at most one issuance and one activation attempt
per page. Competing client activation is resolved by the normal input-revision,
predecessor and fresh-head checks. Rekey, classification, session and same-day
closure proofs remain mandatory; a refused proof does not publish a head or
append an analytical activation journal entry.

Preview is read-only structural eligibility. Apply records owner intent and a
terminal aggregate audit, and stops on storage failure or an uncertain commit
outcome. Failure details retain confirmed completed-candidate counts and a
closed failure stage; `predecessorIssued` records confirmed issuance for the
current attempt, while `currentAttemptMayHaveCommitted` marks an uncertain
predecessor or activation write separately. That current attempt is excluded
from confirmed counts. Failure to write the best-effort terminal audit can leave
only the durable intent, which is not proof that no activation committed.
Results contain only the closed task/method, mode, examined count,
outcome and refusal counts, structurally covered-day count, and an encrypted
pagination cursor. The day count describes the preflight vector until issuance captures a current
candidate, then that captured vector. It can include a candidate that later
refuses; it is not a count of newly accepted days. The `v12r1` cursor is authenticated and bound to owner, schema and mode,
expires after 30 minutes, and stays in browser memory. Do not print, persist,
render or paste it into reports. Page size is at most 25 candidates; a 15-second
budget stops starting new proofs, while an individual proof can run to its
60-second statement limit. A one-second lock limit bounds contention.

For the reviewed owner API caller, start with a single-candidate preview:

```json
{"action":"run_maintenance","v12DomainRecovery":{"dryRun":true,"maxDevices":1,"afterParticipantId":null}}
```

Post to `/api/v1/admin/action` from the authenticated admin origin with the
existing `x-usage-monitor-admin: 1` header and same-origin credentials. Do not
extract cookies, copy Access tokens, impersonate a device, or add a direct
production SQL writer. Preview and apply start separate cursor sequences;
apply changes only `dryRun` to `false`. Keep subsequent cursors in memory and
retain only allowlisted aggregate results. Never retry automatically after a
5xx or lost acknowledgement: inspect the audit and fresh eligibility first.
The existing v1.1 UI buttons do not invoke this new lane.

Qualify the exact candidate using synthetic PostgreSQL 17 tests for both
sharing modes, current authority and processing, pre-existing tokens, latest
candidate selection, stale or competing heads, proof refusals, cursor binding,
rollback, and exactly one journal entry for an accepted activation. Contract and
route checks must reject unknown result fields, raw identifiers and inconsistent
counts. Source checks and a successful origin rollout do not establish recovery
or a model estimate. After approved execution, verify accepted activation and
journal outcomes, run the existing analytics refresh, and inspect the published
model cards. Keep unavailable estimates explicit when the unchanged confidence
rules still do not identify them.

## Shared release gates and retained v1.1 qualification

Use a private, disposable PostgreSQL 17 instance and synthetic fixtures. Run the
owning v1.1 suite, v1.2 unchanged regression, production-composition/privacy
tests, admin cursor tests, typecheck, architecture and preflight checks. Build
the actual origin bundle and admin assets. Verify the kernel identity and
migration prefix remain unchanged. Preserve separate source, packaged image,
staging, production and public aggregate evidence.

The local candidate on 2026-10-11 passed all 18 PostgreSQL domain tests without
skips, the 97 production-host checks, the affected route/admin tests, typecheck,
architecture, documentation and preflight checks. The origin bundle retained
kernel 16 and the migration chain. Cursor tampering and reuse under a different
owner, schema or mode fail before writes. Admin rendering was checked with
clearly labelled synthetic data; it is not evidence of production recovery.

The full release gate is still blocked. At the unchanged base `2fd6d050d`, the
journal producer check flags the offline SQLite corpus sealer, and three web
accounting/plan assertions fail. Each was reproduced in an archived baseline;
this recovery does not change those areas. Resolve their owning gates before
release. A full legacy D1 regression run was stopped after a timeout; the two
affected timeout cases passed in isolation with the original deadline. The full
D1 run is not qualified. Public asset staging must use a clean committed
candidate and the separately verified public release tree.

The server logs closed `telemetry_domain_activation` observations for v1.1 and
v1.2: activation, replay, unchanged, refusal or failure, duration, timestamp,
status and an allowlisted code. No principal, device, generation, token,
request identifier, body, provider message or SQL is logged. A broken log sink
cannot change activation. These observations support aggregate latency and
refusal analysis; they do not identify which historical device failed.
The source candidate also records `refusalPhase` for v1.2 refusals: `state`
for explicit predecessor, input-revision and head checks; `rekey` for a newly
introduced duplicate identity; `classification` for the classification-pair
proof; `session_closure` for session classification closure; and `closure`
for same-day successor closure. Only the corresponding intentional refusal
boundary supplies a phase. Successes, storage failures and unclassified
refusals retain `null`; v1.1 remains unclassified. The phase is private log
metadata and does not alter the public status, error body or headers. Its
presence in source does not establish deployment or identify an earlier failure.

The v1.2 predecessor and activation paths serialize on the participant input
revision before reading the current head in a fresh READ COMMITTED statement.
A competing activation that waited for that lock must compare with the newly
committed head and refuse stale predecessor state. Head publication does not
itself advance the locked input revision; reading both in one joined lock
statement would retain an older head snapshot across that wait.

`telemetry_request_completed` adds counts, status, duration and timestamp for
allowlisted sync, authorization, manifest, contribution and domain operations
after the edge admission boundary. It records successes as well as refusals and
never reads response bodies. Pre-edge refusals retain the existing boundary log.

Do not weaken closures, increase limits, extend credentials, or raise timeouts
to force an unexplained failure through. Reproduce an actual failure on a
synthetic fixture, then use the owning origin release gate for its fix. A kernel
release is required only if analytical semantics change. A migration is required
only if durable schema changes; this candidate adds neither.

## v1.1 owner execution after explicit approval

1. Integrate and release the qualified origin and admin assets using the
   maintained rollout procedures. Deploying this candidate grants no permission
   to run recovery.
2. Under separate production-read approval, use the owner admin preview. Start
   with one device per request when using the API. The request is:

   ```json
   {"action":"run_maintenance","v11EvidenceAdoption":{"dryRun":true,"maxDevices":1,"afterParticipantId":null}}
   ```

   Follow returned cursors in memory. Retain only aggregate outcomes, new and
   preserved day counts, and observation timestamps. Compare the current cohort
   and refusal counts with the approved snapshot; do not assume it is still 28.
3. Review the preview and obtain explicit repair-write approval. The preview
   authorizes no writes. The existing admin preview expires after 15 minutes.
   Execution starts a new cursor sequence and rechecks current evidence; it is
   not bound to a historical list of device identifiers. If the approved cohort
   or counts change materially, stop and review a fresh preview.
4. Run the same action with `dryRun:false` through the owner UI or reviewed API
   caller. Never reuse a preview cursor for execution. A refused or partial page
   is not a completed repair. On 5xx or lost acknowledgement, stop and re-preview
   after the quiet interval. Do not edit heads, mark staged rows READY, delete
   tokens, backfill missing records, or rerun a diagnostic to force progress.
5. Under approved aggregate postcheck reads, confirm adopted day counts, head
   advances, consumed tokens and one journal append per accepted activation.
   Let the existing analytics-refresh path consume the journal. Confirm its
   coverage and publication before claiming community figures include the
   recovered days. No exact public-total impact is predicted from raw chunks.

No temporary Cloud Run job is needed by this owner route. If a separate
diagnostic job is approved, run it once read-only and delete it immediately,
before any rollout preflight; unmanaged jobs conflict with the infrastructure
plan. Do not reuse the earlier diagnostic authorization.

## Devices without recoverable uploads

For an affected owner using the installed desktop app, check that sharing is
enabled and restart the app to allow its existing scheduler to retry. Verify
the upload outcome before declaring recovery. Do not describe restart as a
guaranteed immediate upload, add a hidden manual upload, change a durable opt-out,
or send users unsolicited messages. A manual upload UI, shorter backoff or a
different request deadline needs a desktop release. Credential recovery must
use the existing authorized renewal or pairing flow; it must not extend server
rows by hand. v1.2 stranded days use the separately qualified and authorized
owner recovery lane above; v1.1 adoption is not a substitute.

## Stop and rollback

Stop on changed authority, unexpected cohort growth, unavailable processing,
new successor activity, unexplained refusal, excessive latency, unknown commit
outcome, or failed journal/publication postcheck. Preserve aggregate evidence.
Disable further owner recovery by reverting the task injection in an origin
release if needed. Already accepted generations remain append-only; do not
rewind heads or delete accepted history. Use the maintained incident and
forward-repair procedures for an accepted-data defect.
