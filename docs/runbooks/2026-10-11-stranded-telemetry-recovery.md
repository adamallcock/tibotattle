---
title: Recover stranded telemetry without a desktop release
date: 2026-10-11
type: runbook
status: source-candidate
---

This procedure requires an origin release and an admin asset release. It does
not require a desktop release, a new analytics kernel, or a database migration.
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
older accepted evidence can still contribute. This recovery never activates v1.2
or interprets a successor upload as proof that its new days are public.

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

## Source behavior

`createPostgresV11EvidenceAdoption` is injected into the existing Access-owner
`run_maintenance` action as `v11EvidenceAdoption`. The existing method, CSRF,
bounded body, schema and owner checks apply. It examines accountless devices
with an existing v1.1 head and READY days beyond that head. It:

1. Requires current v1.1 authority and enabled processing.
2. Leaves any participant with v1.2 manifests, a v1.2 head, or active typed
   v1.2 authorization to the successor protocol.
3. Leaves an unused predecessor to its client for its full 24-hour lifetime.
   Preview uses the same 24-hour cutoff as execution.
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

## Qualification and release gates

Use a private, disposable PostgreSQL 17 instance and synthetic fixtures. Run the
owning v1.1 suite, v1.2 unchanged regression, production-composition/privacy
tests, admin cursor tests, typecheck, architecture and preflight checks. Build
the actual origin bundle and admin assets. Verify the kernel identity and
migration prefix remain unchanged. Preserve separate source, packaged image,
staging, production and public aggregate evidence.

The added aged-predecessor regression requires a fresh PostgreSQL 17 run for the
24-hour preview correction; the earlier results below do not qualify it.

The earlier local candidate on 2026-10-11 passed all 18 PostgreSQL domain tests without
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
`telemetry_request_completed` adds counts, status, duration and timestamp for
allowlisted sync, authorization, manifest, contribution and domain operations
after the edge admission boundary. It records successes as well as refusals and
never reads response bodies. Pre-edge refusals retain the existing boundary log.

Do not weaken closures, increase limits, extend credentials, or raise timeouts
to force an unexplained failure through. Reproduce an actual failure on a
synthetic fixture, then use the owning origin release gate for its fix. A kernel
release is required only if analytical semantics change. A migration is required
only if durable schema changes; this candidate adds neither.

## Owner execution after explicit approval

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
   is not a completed repair. On 5xx or lost acknowledgement, stop and re-preview.
   A still-unused predecessor remains client-owned for its 24-hour lifetime;
   wait for that fence before retrying execution. Do not edit heads, mark staged
   rows READY, delete tokens, backfill missing records, or rerun a diagnostic to
   force progress.
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
rows by hand. v1.2 stranded days need their own proof and separately approved
recovery lane.

## Stop and rollback

Stop on changed authority, unexpected cohort growth, unavailable processing,
new successor activity, unexplained refusal, excessive latency, unknown commit
outcome, or failed journal/publication postcheck. Preserve aggregate evidence.
Disable further owner recovery by reverting the task injection in an origin
release if needed. Already accepted generations remain append-only; do not
rewind heads or delete accepted history. Use the maintained incident and
forward-repair procedures for an accepted-data defect.
