---
title: PostgreSQL contribution qualification
date: 2026-09-15
type: plan
status: core-transaction-qualified
---

# PostgreSQL contribution qualification

Scope: a disposable, local PostgreSQL experiment using the extracted v1 write
interface. No Cloud SQL resources, remote migrations or production selection.
The existing D1 and GCS qualifications remain separate evidence.

## Acceptance

- Start a real PostgreSQL server in an isolated temporary directory; record
  pinned binary provenance and stop it after qualification.
- Inject a PostgreSQL client into an experimental adapter; use one connection,
  bounded server-side statement/lock deadlines, explicit rollback and no retry
  after uncertain commit. Never log driver diagnostics or credentials.
- Exercise append, correction, replay conflict, record ownership, authorization
  expiry/revocation, admission races, rollback and lost-response recovery.
- Keep schema creation local and explicit, refuse ambient connection URLs, and
  confine cleanup to a newly created test database.
- Record exactly which D1 projection effects have parity and which remain open.
  An outbox or simplified fixture does not prove the entire hosted application.
- Run portable/Worker typechecks, meaningful real-database tests and owning
  validation; commit source and evidence separately from deployment claims.


## Local qualification result

On 2026-09-15 (America/New_York), the final local PostgreSQL lane passed
26 tests on PostgreSQL 17.10 in 7.43 seconds. The server ran with TCP disabled
and an owner-only Unix socket. The test-created database was dropped; a direct
catalog check returned no remaining `tibotattle_pg_test_*` databases. The server
was then stopped. No GCP resources were created or changed.

The disposable native binary came from
[`@embedded-postgres/darwin-arm64@17.10.0-beta.17`](https://www.npmjs.com/package/@embedded-postgres/darwin-arm64/v/17.10.0-beta.17).
The downloaded tarball matched registry SHA-512:

```text
E2dxhSllrcyAJBHuvgTrBTx2BaPlX2vvjXClPKHxfwBezk+nTZ01uAEraKiRJMpzHSCyN8J1dTjKh4q/uTsBLQ==
```

The pinned test driver is `pg@8.23.0`. An earlier iteration also passed all
26 tests on an isolated PostgreSQL 18.4 container. Its bridge, container and
separate Colima profile were stopped; the default Docker context was preserved.
Only the final native run includes the deterministic two-writer lock barrier
and hostile ambient configuration qualification. Temporary runtime files remain
outside the repository for inspection; they are not application dependencies.

### Proven behavior

- All three streams retain normalized synthetic records, including unknown/null
  fields; a maximum-size 200-record chunk inserts successfully.
- Append/correction, consumed authorization and cleared lease, admission count,
  record ownership, input revision and six dirty requests commit atomically.
- A correction conflict restores the predecessor, records, authorization,
  admission and dirty journal without partial state.
- Participant deletion, accountless owner, transport floor, revoked/expired device,
  authorization digest/expiry/revocation and consent drift fail closed.
- Competing clients are both observed waiting on the participant lock before
  release. Identity, authorization and 2,000/20,000 admission boundaries each
  admit one winner. This qualifies correctness, not throughput or scalability.
- Authorization expiry is checked after a real lock wait. Contention terminates
  at the configured five-second lock deadline.
- Connection loss before commit rolls back. A lost acknowledgement after a real
  commit returns a sanitized unavailable error and discards the connection;
  durable readback shows exactly one write. The adapter never retries blindly.
- The test refuses execution before schema installation. Invalid ambient
  PostgreSQL host/database/options and a synthetic ambient password do not affect
  its explicit local connection. Teardown is limited to its newly created DB.

## Contract and remaining gates

This is a candidate behind the existing provider-neutral write interface, not a
production PostgreSQL selector. Production still injects D1. The candidate uses
one connection per transaction as required by
[node-postgres](https://node-postgres.com/features/transactions), with server-side
statement/lock deadlines and parameterized JSON. Pool acquisition/transport
cancellation remain the responsibility of the injected pool and eventual host.

The fixture deliberately serializes one participant's writes and adds strict
predecessor compare-and-swap. That is an experimental strengthening of the
handler's existing prevalidation, not a claim that all D1 semantics are identical.

Before Cloud SQL wiring for contribution traffic:

1. Port actual daily rebuilds, analysis queues, model-history invalidation ranges,
   prepared-source discard, quota-fit updates and graph preservation/hard
   invalidation. Six dirty rows are not those implementations.
2. Add PostgreSQL reads and receipt reconciliation, authorization issuance,
   quarantine reconciliation and the complete transport/version/legacy blockers.
   A consumed authorization refusal is not application-level idempotent replay.
3. Cover owner erasure, deletion-ledger replay, retention, restore and v1.1
   account-scoped contributions. This v1 candidate intentionally rejects
   accountless owners.
4. Choose the production schema/migration, database roles and least-privilege
   grants, connection pool limits/cancellation, GCP workload identity and host.
   The local test role owns its disposable database; it does not qualify IAM.
5. Rehearse recovery and measure realistic contention/volume before any migration
   or cutover. GCS release-object qualification remains separate from GCS
   quarantine/erasure qualification.

## Repository validation

Portable compilation and all 37 portable tests passed. Worker package-copy
guards, TypeScript, architecture (546 production files, 2,149 imports, no debt),
documentation and preflight checks passed. Implementation and qualification
committed as `04200c78`.

`npm run product:worker:check` passed generated types, package-copy and endpoint
guards, TypeScript, script checks, portable compilation/tests, GCS smoke/asset
plan checks and all 1,071 Worker tests across 86 files (598.83 seconds). It then
exited at `production:stage-assets`: the generated public release manifest is
missing from this worktree. Production/staging dry deployment remains unqualified;
no release artifact was fabricated and no deployment was performed. The suite
also emitted a sandbox warning about its default Wrangler log location; the
reported test counts above are the completed test result, not a claim that the
combined command exited successfully.
