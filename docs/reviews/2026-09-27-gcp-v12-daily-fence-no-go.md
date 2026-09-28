---
title: GCP v1.2 daily publication fence no-go
date: 2026-09-27
type: review
status: snapshot
---

# GCP v1.2 daily publication fence no-go

## Decision and scope

Keep typed v1.2 excluded from PostgreSQL daily totals. The direct typed-v1.2
pricing adapter is implemented and tested, and the six-value 0093 daily pin is
captured and compared. Neither supplies a commit-time fence for the mutable
source authority or for natural authorization expiry. This is a source-level
no-go for publication enablement on the reviewed checkout; it does not assess
live GCP readiness.

Reviewed checkout: branch `codex/gcp-v12-daily-projection`, commit
`1417d20dda8f465061ab02134dc9efa5cf62448d`.

## Verified implementation and policy

The publisher still selects only v1 and v1.1 records. Its public-owner CTE
excludes typed v1.2; active chunks and normalized active records have only the
two legacy source formats (`apps/worker/src/postgres-community-daily-publisher.ts:275-285,375-456`).
The committed typed pricing adapter reads closed typed fields directly and
preserves explicit cache-write TTL buckets; it does not synthesize legacy JSON.
Focused pricing tests and Worker typecheck passed in the preceding scoped
commit `1417d20d`.

The six-value pin in staged primary migration 0093 is nullable for historical
rows and stores both runtime states/revisions plus active authorization count
and next expiry. The publisher captures and compares those values
(`apps/worker/postgres/staged-migrations/primary/0093_community_daily_v12_authority_pin.sql:1-42,44-104`,
`apps/worker/src/postgres-community-daily-publisher.ts:690-755,784-799`).
This correctly prevents reusing a published daily revision after a *visible*
pin change.

The exact typed read authority is more specific than the five-branch public
owner view. Migration 0046 defines social, v1.1 active/retained, and v1.2
active/retained branches, with v1.1-domain precedence and an exact accepted
head marker for retained v1.2. Migration 0025 requires active v1.2 runtime
policy for active authorization, retains social accepted/revoked capability
rows under an active owner link, and retains accountless expired-active or
exact `user_opt_out` authorization under that link
(`apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql:491-654`,
`apps/worker/postgres/migrations/primary/0025_typed_v12_normalized.sql:49-112`).
The existing owner terminal-event and source-cursor checks must remain intact.

## Decisive commit-fence gap

The daily mutation starts with `SELECT pg_advisory_xact_lock(...)`, then calls
`captureFence()` (`apps/worker/src/postgres-community-daily-publisher.ts:842-848`).
The transaction helper uses `REPEATABLE READ` and sets statement and lock
timeouts, but no transaction timeout
(`apps/worker/src/postgres-client.ts:260-273,298-326`). The fence query uses
`FOR SHARE` on source/cursor, legacy admission, publication, collection, and
the two runtime rows. Its accountless grant count and next expiry are read
from the same repeatable-read snapshot; authorization and social capability
tables are not locked by the publisher
(`apps/worker/src/postgres-community-daily-publisher.ts:701-737`).

Consequently, an authorization mutation that commits after the first advisory
SELECT can be invisible to both the source projection and six-value pin while
the daily transaction continues. Migration 0014/0046 advances the source
journal from v1.1/v1.2 domain-head changes; the v1.2 head trigger is not a
trigger on accountless authorization or social capability changes
(`apps/worker/postgres/migrations/primary/0014_effective_source_revision.sql:208-222`,
`apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql:779-819`).
The immutable aggregate could therefore be committed from an old authority
snapshot after a source-authority transition. Separately, the active grant
count uses `statement_timestamp()` while typed authorization views use
`now()`; no current daily transaction bound prevents the captured expiry from
crossing before commit.

The 0093 migration itself states that its pin is preparatory and that
authorization writes and expiry still need a commit-time fence
(`apps/worker/postgres/staged-migrations/primary/0093_community_daily_v12_authority_pin.sql:1-5`).
Do not treat successful typed pricing or unchanged-pin tests as closing this
gap.

## Required follow-up gate

Coordinate an additive primary migration before enabling the source. A
reviewable option is a monotonic public-v1.2 authority generation, advanced in
the same transaction for every source-eligibility-affecting change to owner,
device, grant, capability, retention-marker, and owner-link state. Capture and
lock that generation in the daily revision fence so a concurrent committed
change yields either a new generation or a repeatable-read serialization
failure. Keep the six 0093 values as separate semantic pins. If table locks are
chosen instead, acquire the complete authority lock set before the advisory
SELECT or any other snapshot-taking statement, and prove lock order against the
accountless renewal, disconnect/opt-out, social consent, and owner-erasure
mutators.

Natural expiry needs a PostgreSQL 17 transaction-time bound and a fail-closed
look-ahead check with enough margin to keep every captured active authorization
valid through commit. Tests must show that an authorization writer either
commits before the publisher's snapshot or waits until after publication,
that a close-to-expiry row refuses publication, and that an expiry crossed
during a bounded transaction cannot produce an `unchanged` result. Add tests
for social capability/owner erasure, active and exact-retained accountless
eligibility, same-device v1.1 precedence, typed TTL pricing, and deduplication
before wiring v1.2 into totals.

No source projection or PG17 race test was added in this snapshot. No live GCP
or Cloudflare resource was read or changed for this review.
