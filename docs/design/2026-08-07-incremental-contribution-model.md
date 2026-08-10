---
title: Incremental Full-History Contribution Model
date: 2026-08-07
type: design
status: proposed
---

# Incremental Full-History Contribution Model (telemetry-contribution-v1.0)

## Why

The product will not ship with the current sample-based upload. The owner's
decision, verbatim: "if we are creating a 100mb database of info that needs to
be uploaded, then that is what we should really be uploading... 6 hours later
if there is 101mb we upload the incremental 1mb." Contributions become the
full local history, uploaded incrementally, and server aggregates recompute
whenever new or revised history lands: "if we generate for say the month of
June and then we get a BUNCH of logs that tighten our prediction, then we
absolutely should update June."

This document designs that model end to end: cursor protocol, chunking,
server-side revisioning in place of sealing, the one-time consent, contract
versioning, migration of existing test contributions, and sizing against
measured local data. It is release-critical: v0.1.0 ships this instead of
iterating on the sample flow in situ.

Upload source of truth: the unified local index
([design](./2026-08-06-unified-local-index-schema.md), as amended in-file) —
one SQLite store with typed `usage_event` rows (~115 B/row), a deduplicated
`quota_observation` series, a per-session dimension with `upload_pseudonym`
precomputed, and a `parser_version` stamp on every row.

## Owner decisions this design is bound by

1. Contributions are the full history, uploaded incrementally.
2. No aggregate sealing; aggregates recompute as late or revised data arrives,
   and "if our prediction was good, the range should just tighten."
3. Daily aggregation or finer; the weekly block is rejected. Events are
   per-turn, so the transport grain is the individual event and the aggregate
   grain is the UTC day.
4. k-anonymity thresholds are not a launch concern; nothing in this design
   suppresses or blocks daily buckets.
5. Consent is to the kind of data, approved once — "The review before sending
   is really about reviewing the kind of data rather than the shape."
6. Upload identity is the per-session pseudonym `HMAC(device_salt,
   session_uuid)` with a device-local, non-rotating salt. The rotating
   export-secret pathway is retired (two rotating secrets have already been
   retired on this machine).

## 1. Contract version: telemetry-contribution-v1.0

**Decision: this is v1.0, not v0.3.**

- The v0.1 family is machine-readably `draft_local_only_unfrozen` with
  `transportReady: false`, and its own freeze rule
  (`contracts/telemetry-v0.1/contract-status.json`) states: "The first
  volunteer or upload-capable contract must use a new version and preserve
  every frozen predecessor unchanged." The full-history contribution contract
  is exactly that first upload-capable contract, so it is the first frozen
  version and carries the first compatibility promise. Calling it v0.3 would
  place a frozen launch contract inside the explicitly unfrozen v0.x
  local-draft line.
- **v0.2 is retired, not absorbed.** The account-scoped v0.2 machinery
  (`schemas/telemetry-contribution-v0.2/`,
  `packages/telemetry-contract/schemas/v0.2/`,
  `apps/worker/src/telemetry-v0.2.ts`,
  `apps/worker/src/account-scoped-ingest.ts`,
  `src/contribution/telemetry-v02-projection.js`) was never enabled in
  production: `ACCOUNT_SCOPED_INGEST_MODE` is `"disabled"` in every
  environment of `apps/worker/wrangler.jsonc`, and the schema itself pins
  `"status": { "const": "implementation_disabled" }` — it cannot ship as-is
  by construction. Its gating decision
  ([account track transport minimization](../decisions/2026-07-26-account-track-transport-minimization-decision.md))
  requires prospective evidence (three completed account-scoped reset
  windows) that still does not exist. Retirement means: delete the v0.2
  ingest/projection code and its specs, keep the applied D1 migrations
  0007/0011 (migrations are append-only; the tables sit empty and harmless),
  and mark the decision record superseded-for-transport. Account scope, if it
  ever passes its evidence gates, becomes a v1.1 field addition under the
  re-approval rule in §5 — which is a cleaner consent story than shipping it
  disabled inside v1.0.

### Contract content changes from v0.1

The v1.0 record kinds follow the unified index tables, because the index is
the upload source:

| v1.0 record kind | Source table | Change from v0.1 |
| --- | --- | --- |
| `usageEvents` | `usage_event` | Gains `sessionUuid`; loses per-event `toolClassCounts` |
| `quotaObservations` | `quota_observation` | Deduplicated series replaces raw per-sighting `quotaSnapshots` |
| `sessionDimensions` | `session` + `tool_class_count` | New: `sessionUuid` + tool-class counts per session |
| `activityMarkers` | — | Retired (see open question 3) |

- `sessionUuid` is the precomputed `session.upload_pseudonym` =
  `HMAC(device_salt, session_uuid)` (owner decision 6). It is a new
  transported field: v0.1's projection deliberately dropped all session scope
  from transport rows. The privacy contract's field-purpose matrix
  ([telemetry privacy contract](../governance/2026-07-24-telemetry-privacy-contract.md))
  already classifies session HMAC pseudonyms as allowlisted-never-published,
  but transporting them is a change that goes through that document's field
  ritual and forces the (first-run anyway) consent described in §5.
- `toolClassCounts` moves from every usage event to the per-session dimension
  record, matching the index's `tool_class_count` table and cutting the
  largest fixed-cost object out of the per-event row.
- Chunk metadata (below) is envelope-level: `chunkId`, `chunkRevision`,
  `chunkDigest`, `parserVersion`, `contractVersion`.

The per-envelope transport caps are kept: at most 200 records and 1,250,000
canonical bytes per envelope (`src/contribution/telemetry-v01-projection.js`:
`MAX_TOTAL_RECORDS`, `assertTransportProjection`). At the measured 1,250 B/row
minified upper bound a full 200-record envelope is ~0.25 MB, so the record cap
binds and the byte cap stays a guard.

## 2. Source identity and the non-rotating device salt

The cursor is keyed **(participant, device)**. Devices already exist
server-side (`apps/worker/migrations/0008_device_upload_registration.sql`,
`device_credentials`), and sessions are device-local, so two devices of one
participant have disjoint chunk namespaces and never contend for one cursor.

The `device_salt` is generated once, stored in its own macOS Keychain item
alongside the existing export identity, and **never rotates** (owner decision
6). This is what makes `sessionUuid` stable across uploads, which is what
makes server-side dedupe and chunk supersession work across time. Losing the
salt (Keychain reset) is treated as a new device: old chunks remain valid
under the old pseudonyms, the new device re-syncs history under new
pseudonyms, and the server cannot link the two — an accepted, documented
failure mode consistent with the existing "do not reset the Keychain to clear
an access error" guidance.

**Flag — index doc amendment required.** The unified index design's "What must
not regress" section still says sent values are "always
`HMAC(export_secret, ...)`, computed at send time," and decision 2 in that
file praises cheap export-secret rotation. Both statements describe the
retired rotating pathway and contradict owner decision 6 and that same
document's own amended `session.upload_pseudonym` column. The index doc must
be amended in-file when this design lands; the consent copy must state plainly
that pseudonyms are stable over time.

## 3. Cursor protocol

### Chunk model

History is deterministically partitioned into chunks, client-side, from the
unified index:

- **Partition**: per stream (`usage`, `quota`, `session`), per UTC day.
  `usage` rows partition by `observed_at_ms`; `quota` by its own
  `observed_at_ms`; `session` records by the day of the session's first event.
- **Order**: within a day, rows sort by `(observed_at_ms, primary key)` — a
  total order that any two scans of the same index reproduce exactly.
- **Split**: the ordered day splits into segments of at most 200 records.
  Chunk id = `stream:YYYY-MM-DD:seq`.
- **Digest**: `chunkDigest` = SHA-256 over the canonical minified JSON array
  of the chunk's transport rows (the canonical serialization already exists on
  both sides: `stableJson` in the client projection,
  `apps/worker/src/canonical-json.ts` in the worker). The digest is computed
  over post-pseudonymization content, so it is comparable across re-scans.
- **Day digest**: SHA-256 over the concatenation of the day's chunk digests,
  in sequence order. Manifest comparison prunes at day granularity first.

Because the sort and split are deterministic, a re-scan that changes nothing
produces byte-identical chunks; a re-scan that changes or adds any row in a
day changes that day's digests and only that day's.

### What the server knows, and how the client learns it

The server is authoritative for what it has accepted; the client is
authoritative for what exists locally. Two read endpoints and one write:

1. `GET /api/v1/device/sync/state` → `{ contractVersion,
   acknowledgedThroughDay, historyDigest }`, where `historyDigest` is a
   SHA-256 over all accepted day digests in order. One cheap call per sync
   run: if `historyDigest` matches the client's local computation for the
   accepted range and `acknowledgedThroughDay` matches the local cursor, the
   client uploads only days after the watermark.
2. `GET /api/v1/device/sync/manifest?fromDay=&toDay=` → per-day digests, and
   per-chunk `{chunkId, revision, chunkDigest, recordCount}` for requested
   days. Used only when (1) mismatches: after an interruption, a parser
   re-scan, or a fresh reinstall. A full manifest for ~5,300 chunks is well
   under 1 MB and is paginated by day range.
3. `POST /api/v1/contributions` (existing route, extended envelope): the
   encrypted envelope carries `{ chunkId, chunkRevision, chunkDigest,
   parserVersion, records }`. The worker decrypts, recomputes the canonical
   digest, rejects on mismatch, journals the chunk, and returns the updated
   `acknowledgedThroughDay`.

The client persists its cursor (`acknowledgedThroughDay`, last
`historyDigest`, per-day digests) in the existing durable sync store
(`~/Library/Application Support/app-usagemonitor/private/contribution-sync-v0.1.sqlite3`,
schema extended), but the persisted copy is a cache: any disagreement with the
server resolves by re-fetching the manifest and re-sending, never by trusting
local state.

### Resumability and overlap

Re-sending an already-accepted chunk is free by construction:

- Identical envelope replay dedupes on the existing
  `UNIQUE (participant_id, plaintext_digest)` /
  `UNIQUE (participant_id, envelope_digest)` constraints
  (`apps/worker/migrations/0002_telemetry_ingest.sql`) — the server answers
  "accepted" idempotently, a behavior the backend smoke already pins
  ("idempotent replay with a new upload authorization").
- Record-level overlap between differently-shaped envelopes dedupes on
  `UNIQUE (participant_id, record_kind, occurrence_id)`.

So the failure story is simply: resume from the watermark, re-send anything
uncertain, and let dedupe discard the overlap.

### Rewritten history: revisions

A parser-version re-scan changes past rows (the index stamps every row with
`parser_version_id` precisely to allow this). The server learns through
digests, not through any change notification:

1. The re-scan updates rows; affected days' chunk digests change.
2. The next sync run's `historyDigest` mismatch triggers a manifest diff; the
   client identifies exactly the changed days, then the changed chunks.
3. Each changed chunk is re-sent with `chunkRevision = previous + 1`. The
   server journals the new revision, marks the prior revision superseded,
   atomically replaces that chunk's records in the current view, and enqueues
   the affected day's aggregates for rebuild (§4).

Unchanged chunks are never re-sent — a parser change that touches one field
family re-uploads only the days it actually altered.

**Flag — ingest semantics change.** Today's ingest is `INSERT OR IGNORE` on
record identity (`apps/worker/src/telemetry-repository.ts:340,426,472`; the
comment at `:634` documents that an already-seen record stores nothing). Under
revisioning, that comment stays true *within* a revision, but a
higher-revision chunk **replaces** its records — a rewritten row with the same
`occurrence_id` and new token values must win, where `INSERT OR IGNORE` would
silently keep the stale values. Tests pinning replay-is-a-no-op
(`apps/worker/test/worker.spec.ts` idempotent-replay coverage) must be
re-pinned: same-digest replay remains a no-op; higher-revision supersession
replaces.

### Ordering, parallelism, failure mid-stream

Strictly sequential, oldest day first, one envelope in flight. Parallelism
buys nothing: the production per-principal upload rate limit is 6/min
(`UPLOAD_PRINCIPAL_RATE_LIMIT`, `apps/worker/wrangler.jsonc` production env),
so a single sequential stream saturates the budget, and a contiguous
watermark stays trivially correct. Each envelope acquires an upload
authorization and an ingress lease exactly as today
(`apps/worker/src/ingress-budget.ts`; production policy 8 concurrent,
120 starts/min, burst 16, 90 s leases). Envelope acceptance is atomic in D1;
a mid-stream network failure leaves the prefix acknowledged, the failed chunk
un-journaled, and the client retries it with a fresh authorization. Repeated
failure pauses the run and surfaces the paused state in the UI (§5) rather
than spinning.

## 4. Revisioning instead of sealing

### Server data model

Append-only journal + derived current view + derived aggregates:

```sql
-- Journal: append-only, one row per accepted chunk revision.
CREATE TABLE contribution_chunks (
  participant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('usage','quota','session')),
  chunk_day TEXT NOT NULL,            -- UTC day, 'YYYY-MM-DD'
  chunk_seq INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  chunk_digest TEXT NOT NULL,         -- sha256 hex of canonical plaintext rows
  contribution_id TEXT NOT NULL REFERENCES telemetry_contributions(id)
    ON DELETE CASCADE,
  record_count INTEGER NOT NULL,
  superseded_at TEXT,                 -- NULL while current
  created_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, device_id, stream, chunk_day, chunk_seq,
               revision),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) STRICT;
```

- `telemetry_contributions` remains the envelope journal (R2 pointer,
  digests, admission) and gains the chunk linkage. Its
  `CHECK (schema_version = 'telemetry-contribution-v0.1')` is widened by
  migration (flagged below).
- `telemetry_records` remains the **current view**: on supersession the old
  revision's records are deleted and the new revision's inserted in one
  transaction. "Append-only with revision supersession" lives in
  `contribution_chunks` plus the retained R2 envelopes; the current view is
  always exactly the latest revision of every chunk.
- R2 quarantine retention is unchanged
  (`apps/worker/src/contribution-lifecycle.ts`): superseded envelopes age out
  on the existing schedule.

### Aggregates: daily grain, recompute-on-arrival

The aggregate unit becomes the UTC day (owner decision 3). The mechanism
deliberately reuses the revisioned-snapshot pattern that migration
`apps/worker/migrations/0012_revisioned_aggregate_rebuild.sql` already
established — published revisions are immutable rows; recomputation writes
revision N+1 — and extends *when* rebuilds are enqueued:

```sql
CREATE TABLE community_daily_aggregates (
  aggregate_id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source_mutation_epoch INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  release_state TEXT NOT NULL
    CHECK (release_state IN ('published','withdrawn')),
  released_at TEXT NOT NULL,
  withdrawn_at TEXT,
  UNIQUE (day, revision)
) STRICT;

CREATE TABLE community_daily_aggregate_rebuilds (
  day TEXT PRIMARY KEY NOT NULL,
  requested_epoch INTEGER NOT NULL,
  requested_at TEXT NOT NULL
) STRICT;
```

Rebuilds are enqueued by three events, the first of which is the new one that
implements "no sealing":

1. **Late or revised data arrives**: an `AFTER INSERT` trigger on
   `contribution_chunks` enqueues `chunk_day` whenever a published aggregate
   for that day exists. June recomputes when June data lands in August.
2. **Chunk supersession**: same trigger path on revision replacement.
3. **Deletion**: participant deletion and contribution deletion enqueue every
   published day, exactly as 0012's triggers do for weekly snapshots today.

The hourly cron (`"crons": ["0 * * * *"]`, already configured) drains the
queue: at most one rebuild per day-bucket per pass, so a burst of late data
coalesces into one recomputation. Between arrival and rebuild, the published
revision is at worst one hour stale — visible, versioned, and honest.

Per owner decision 4, daily buckets carry **no** suppression threshold that
can block publication. The per-cohort suppression machinery in the weekly
snapshots (pinned by worker.spec's per-cohort suppression proofs) is not
carried into the daily grain; those tests are re-pinned, not silently kept.

**What replaces triggers 0005/0012.** The *immutability* pattern survives: a
published `community_daily_aggregates` revision row gets the same
immutable/no-delete trigger pair as 0012's weekly snapshots, because "no
sealing" means *the series recomputes*, not *rows mutate*. What is replaced is
the **sealing semantics**: `community_weekly_snapshots`, its builders table,
and its cutoff-then-never-recompute lifecycle are retired. The public weekly
view becomes a read-time derivation over daily aggregate revisions. With the
§6 purge, the weekly tables are dropped empty rather than migrated.

### The hard privacy invariant: participant deletion still purges everything

Deletion must remain total, and it does, because every new structure hangs off
the same participant row:

- `contribution_chunks` carries `FOREIGN KEY (participant_id) REFERENCES
  participants(id) ON DELETE CASCADE` and `contribution_id ... ON DELETE
  CASCADE` — deleting the participant or a contribution removes the journal
  rows in the same statement, exactly as `telemetry_records` and
  `telemetry_contribution_occurrences` cascade today (0002).
- R2 quarantine objects are purged by the existing deletion flow, and the
  deletion tombstone is written to the physically separate ledger database
  (`apps/worker/deletion-ledger-migrations/0001_deletion_tombstones.sql`,
  written via `apps/worker/src/retention.ts`), which blocks credential and
  identity reuse post-deletion (`apps/worker/src/index.ts` tombstone checks).
- Aggregates derived from the deleted participant are withdrawn and rebuilt by
  the deletion-enqueue triggers (event 3 above) — the 0012 withdrawal +
  rebuild-queue pattern, retargeted at daily aggregates. The backend smoke
  already pins "rebuilds the affected aggregate as a new immutable
  privacy-suppressed revision after contribution deletion and again after
  complete participant deletion"; the assertion is re-pinned against the daily
  tables with identical intent.

Nothing in the revisioning model weakens this: a superseded revision's records
are already gone from the current view, its journal row cascades, and its R2
envelope is deleted by the same purge that handles current envelopes.

## 5. Consent once

### What the user approves

The kind of data, shown as the actual field list. The consent screen renders
the v1.0 field dictionary — every transported field of
`schemas/telemetry-v0.1/usage-event.schema.json` as carried into v1.0
(token-count integers, model id or keyed fingerprint, tier/surface/outcome
enums, timestamps, quota percentages, tool-class counts, session and event
pseudonyms), grouped by the purpose matrix of the
[telemetry privacy contract](../governance/2026-07-24-telemetry-privacy-contract.md) —
plus three sentences of plain product truth:

1. Your full usage history uploads, then new events upload roughly every
   6 hours.
2. Community estimates recompute when your data (or corrections to it)
   arrives, including for past months.
3. Deletion removes everything you contributed, always.

The first run keeps the existing `reviewBootstrap` requirement
(`src/contribution/recurrence-policy.js`): the user inspects one concrete
prepared chunk before enabling — reviewing the kind via a real instance, once.

### How approval is stored

The existing consent record is already shaped correctly and is reused
unchanged in structure (`src/contribution/recurrence-policy.js`,
`CONSENT_KEYS`): `{ consentedAt, destinationOrigin, fieldDictionaryVersion,
privacyContractVersion, telemetrySchemaVersion }`, persisted in the automatic
contribution settings (schema bumps from
`automatic-contribution-settings-v0.4` to v0.5 to add the cursor state). The
values become the v1.0 identifiers: `telemetrySchemaVersion =
"telemetry-contribution-v1.0"`, a new `fieldDictionaryVersion` from the
regenerated registry (currently
`telemetry-v0.1-registry-2026-08-06.1`, `src/export/registries.js`), and a new
`privacyContractVersion` superseding
`ongoing-privacy-safe-telemetry-v0.1`.

### What forces re-approval

Exactly the existing mechanism: `consentCurrent` compares the stored record
against the currently required values and auto-upload halts on any drift
(`recurrence-policy.js` `sameRequiredConsent` / `consentCurrent`;
`local-automatic-contribution.js` refuses to run when `!consentCurrent`). Any
contract field addition bumps `telemetrySchemaVersion` and
`fieldDictionaryVersion` by the privacy contract's own ritual, so a field
addition mechanically forces re-approval. Destination origin changes do too.
Nothing else re-prompts: batches never re-prompt, cadence never re-prompts.

### UI states while auto-upload runs

The product's honesty rules apply: say what is being sent and when, and never
claim more than the watermark. Four states, all showing the destination
origin and the cursor:

- **Idle / scheduled**: "Contributing usage metadata to tibotattle.com.
  Uploaded through <acknowledgedThroughDay> (<n> of <m> events). Next upload
  ~<nextAttemptAt>." The 6-hour cadence with bounded dither is the existing
  scheduler (`AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS = 6`).
- **Uploading**: "Uploading <day range>, chunk <k> of <n> this run." Live
  count, not a spinner.
- **Paused / failing**: the reason (offline, rate-limited, server error code)
  and the unchanged watermark. Failures never silently retry forever.
- **Re-approval required**: shown when `consentCurrent` is false, with the
  field diff that caused it. Auto-upload is stopped, not degraded.

First full sync gets an explicit progress surface (hours-long, §7), with pause
and resume; pausing is honored at the next chunk boundary.

## 6. Migration of existing v0.1 contributions

**Recommendation: purge before launch.** Production has only test
contributions — `ENROLLMENT_MODE` is `"disabled"` in the production
environment and the enrolled participants are the owner's own smoke and curl
tests; nothing real is enrolled. The owner has sanctioned purging.

Path: run the existing complete-deletion flow for each test participant
(already exercised end-to-end by the backend smoke, including tombstones and
R2 cleanup), then a migration that drops any orphaned telemetry rows, drops
the empty weekly-snapshot tables, widens the `schema_version` CHECK, and
creates the §4 tables.

What purging saves, concretely:

- **No dual-contract ingest**: the worker never needs to accept v0.1 and v1.0
  envelopes side by side, and the aggregate builder never merges records with
  and without session pseudonyms and chunk identity.
- **No unsupersedable rows**: v0.1 rows have no chunk id, digest, or device
  binding — they could never participate in revision supersession and would
  be a permanent special case in every rebuild query.
- **No weekly→daily backfill**: the weekly snapshot history is test data;
  dropping it empty avoids writing a derivation nobody will read.
- **No R2 mixed-version retention logic.**

Keep-and-supersede is the fallback only if real participants exist at
implementation time, and it costs all four of the above.

## 7. Sizing, with measured figures

Inputs (measured on this machine, 2026-08-07, from
`local-analysis-index-v2.sqlite`, 158,715,904 bytes on disk; plus the unified
index design's measurements):

| figure | value | source |
| --- | ---: | --- |
| suppressed events awaiting upload | ~462,503 | owner brief, collector accounting |
| usage facts in today's analysis index | 264,538 | direct query |
| quota facts in today's analysis index | 301,532 | direct query |
| whole corpus after full re-index | ~1.06M records | unified index design |
| bytes/record, minified JSON (upper bound) | 1,250 | unified index design |
| bytes/row, typed store | ~115 | unified index design |
| daily usage events, 14-day mean | 10,419/day | direct query |
| daily quota facts, 14-day mean | 10,758/day | direct query |
| history span | 2026-06-12 → 2026-08-07, 55 active days | direct query |

**First full sync.** At 200 records/envelope:

- Events-only (owner's operative figure): 462,503 → **2,313 envelopes**.
- Today's index, both streams before quota dedupe: 566,070 → 2,831 envelopes.
- Post-full-re-index corpus: ~1.06M → **~5,300 envelopes** (upper bound; the
  `quota_observation` dedupe shrinks the quota stream below the raw fact
  count — re-measure at implementation).

Transport volume: at the 1,250 B/row minified upper bound, envelopes run
~0.25 MB, so the full history is ≤ ~700 MB of canonical JSON (before
envelope encryption overhead); the byte cap never binds.

**Duration at production limits.** The binding limit is
`UPLOAD_PRINCIPAL_RATE_LIMIT` = 6/min per principal. Sequential upload:
2,313 envelopes ≈ **6.4 hours**; 5,300 ≈ **14.7 hours**. One syncing device
consumes 1 of 8 global concurrency slots and 6 of 120 global starts/min, so a
single participant's first sync is invisible to the fleet; ~20 devices
first-syncing simultaneously saturate global starts and stretch everyone
proportionally — acceptable for launch scale, revisit the global caps before
any cohort onboarding push.

**Steady state.** 14-day means give ~21,177 records/day both streams
(~10.4k/day usage alone) → **~53–106 envelopes/day**, i.e. one 6-hour cycle
uploads ~13–27 envelopes in ~2–5 minutes at the principal rate limit. In
store terms that is ~2.4 MB/day of typed rows (~0.6 MB per 6-hour cycle) —
the same order as the owner's "101mb ... upload the incremental 1mb" framing —
and low tens of MB/day as transport JSON.

**Consequence — the admission window is wrong for this model.** The weekly
admission trigger caps 100 accepted contributions per participant per week
(`apps/worker/migrations/0014_bounded_contribution_admission.sql`). Steady
state alone needs ~370–740 envelopes/week and first sync needs thousands in a
day. The admission unit must change from "envelopes per week" to a budget
sized for the model — e.g. accepted-record volume per device per day, with a
first-sync allowance. This is an abuse bound, so the constant is an owner
decision (open question 1); the design requirement is only that admission be
generous to the sync pattern above and still bounded.

## 8. Every contradiction with existing tests, triggers, and constants

Implementers re-pin each of these deliberately; none may be silently deleted.

1. **`0002_telemetry_ingest.sql`**: `CHECK (schema_version =
   'telemetry-contribution-v0.1')` on `telemetry_contributions` rejects v1.0
   envelopes. Migration widens it; specs asserting the accepted version
   string re-pin.
2. **`0014_bounded_contribution_admission.sql`**: the 100/week admission
   trigger blocks both first sync and steady state (§7). Replace with the
   record-volume budget; its tests re-pin to the new unit.
3. **`INSERT OR IGNORE` record dedupe**
   (`apps/worker/src/telemetry-repository.ts:340,426,472`, comment `:634`) and
   the idempotent-replay specs: same-digest replay stays a no-op; a
   higher-revision chunk now replaces its records (§3). New supersession
   tests; old "already-seen stores nothing" assertions re-scoped to
   within-revision.
4. **`0005`/`0012` weekly snapshot machinery**: sealing semantics retired;
   `community_weekly_snapshots`, builders, and their immutable/no-delete and
   withdrawal triggers are replaced by daily aggregates with the same
   immutable-revision pattern plus arrival-triggered rebuilds (§4). worker.spec
   coverage of scheduled weekly publication, sealed-snapshot immutability, and
   per-cohort suppression re-pins against the daily tables — and the
   suppression thresholds do **not** carry over to daily buckets (owner
   decision 4).
5. **`MAX_PREPARED_CONTRIBUTION_BATCHES = 100`**
   (`src/contribution/prepared-set-contract.js`) and the `export_too_large`
   single-reviewed-set ceiling: the review-set flow is not the sync path
   anymore. First sync is thousands of chunks driven by the cursor, not a
   prepared set. The prepared-set flow remains for manual export/recovery;
   `batch_count_invalid` tests re-pin to that scope.
6. **Transport canary** (`assertTransportProjection`,
   `src/contribution/telemetry-v01-projection.js`): the regex forbidding
   `sessionScopeId` in serialized transport embodies "no session scope leaves
   the device." v1.0 deliberately transports `sessionUuid`. The canary is
   re-pinned, not dropped: raw scopes (`accountScopeId`, `sessionScopeId`,
   `participantId`, `providerStateId`) stay forbidden; the new field is
   allowlisted by exact name. Export owner-boundary tests re-pin likewise.
7. **Rolling-window scheduler constants**
   (`AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS = 24`,
   `AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS = 1`,
   `src/contribution/recurrence-policy.js`): the lookback/overlap sampling
   model is replaced by the cursor; the 6-hour interval and dither survive.
   Settings schema bump v0.4 → v0.5; recurrence-policy tests re-pin.
8. **`0008_device_upload_registration.sql`**: `CHECK (consent_version =
   'ongoing-privacy-safe-telemetry-v0.1')` on `device_pairings` pins the old
   consent identifier; migration widens it to the v1.0 privacy contract
   version.
9. **Unified index doc**: the "What must not regress" send-time
   `HMAC(export_secret, ...)` language and the rotation-is-cheap rationale in
   decision 2 contradict the non-rotating device salt (§2). Amend in-file.
10. **v0.2 family**: `implementation_disabled` schemas, worker code, client
    projection, and their specs are removed (§1); the
    [minimization decision](../decisions/2026-07-26-account-track-transport-minimization-decision.md)
    is marked superseded-for-transport with its evidence gates preserved for a
    future v1.1.

## 9. Implementation plan by owner

Order matters: contract → worker → client. Each owner's first task is
unblocked only as noted.

### Contract package (packages/telemetry-contract, schemas/, contracts/)

Blocking dependency: none — starts first; everything else consumes it.

1. Freeze `telemetry-contribution-v1.0`: usage-event (with
   `sessionUuid`, without per-event `toolClassCounts`),
   quota-observation, session-dimension, and envelope schemas with
   `chunkId`/`chunkRevision`/`chunkDigest`/`parserVersion`; sync-state and
   manifest response schemas.
2. New `contract-status.json` for the v1.0 family (frozen,
   `transportReady: true`); regenerate the field dictionary; new
   privacy-contract version identifier.
3. Retire the v0.2 exports from `packages/telemetry-contract` and
   `schemas/telemetry-contribution-v0.2/` per §1.

### Worker (apps/worker) — follows the #34 agent

Blocking dependency: the frozen v1.0 schemas from the contract package.

1. Purge migration (§6), then schema migrations: `contribution_chunks`,
   `telemetry_contributions` chunk linkage and widened CHECKs (items 1 and 8
   in §8), daily aggregates + rebuild queue + trigger set (§4), admission
   re-pin (item 2) once the owner sets the constant.
2. Endpoints: `GET /api/v1/device/sync/state`,
   `GET /api/v1/device/sync/manifest`, extended `POST /api/v1/contributions`
   with server-side digest verification and revision supersession.
3. Re-pin the §8 worker tests; add the deletion-invariant test: participant
   delete purges journal, current view, R2, tombstones, and triggers daily
   aggregate withdrawal/rebuild.

### Client (src/, apps/macos, apps/web) — follows the wiring agent

Blocking dependencies: the unified local index implementation (upload source),
then the worker sync endpoints.

1. Device salt keychain item and precomputed `upload_pseudonym` wiring (§2).
2. Cursor engine: deterministic chunker + digests over the unified index,
   manifest diff, sequential uploader over the existing sync queue store,
   revision re-send on re-scan.
3. Consent v1.0: settings schema v0.5, field-dictionary review screen,
   re-approval gate; retire lookback/overlap sampling (item 7).
4. Status surfaces (§5): watermark, per-run progress, paused reasons,
   first-sync progress with pause/resume.

## 10. Open questions that genuinely need the owner

1. RESOLVED 2026-08-07, owner deferring to the maintainer: circuit breakers,
   not quotas - 2,000 envelopes/device/day steady state and 20,000/device/day
   for the first 7 days after device registration. Sized against the real
   index: a full first sync is ~5,720 envelopes (462,503 usage events +
   681,216 deduplicated quota observations at 200/envelope), so first sync
   fits inside one budget-day and steady state (~50-110/day) keeps 20-40x
   headroom. The bound exists solely so a resend-looping client or a script
   cannot run up the D1/R2 bill unbounded.
2. **Quota stream depth**: recommend uploading the deduplicated
   `quota_observation` series (what the unified index stores), not the raw
   per-sighting fact stream — roughly halves first-sync volume. Confirm.
3. RESOLVED 2026-08-07: activity markers are retired from transport and the
   manual CLI ritual is deprecated to the roadmap. The invisible-surface
   problem they addressed is narrower than the vocabulary implied - the owner
   clarifies that plain ChatGPT web chat is free and consumes nothing, that
   ChatGPT Work via the web is the cloud surface, and that a phone remoting
   into the desktop is captured by the local logs - and the meaningful gap
   that remains should eventually be covered by something automatic or
   one-click, not by a CLI command that measured usage shows was run exactly
   zero times.
4. RESOLVED 2026-08-07: the owner ruled session identifiers travel as the raw
   provider-issued `session_uuid`, and the pseudonym machinery is deleted
   entirely. The field-purpose matrix states they are provider-issued
   pseudonymous identifiers, not hashes.
