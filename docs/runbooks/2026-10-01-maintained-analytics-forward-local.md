---
title: Maintained analytics local forward operator
date: 2026-10-01
type: runbook
status: local-only
---

# Maintained analytics local forward operator

This is the local H06 packaging interface for the uncommitted maintained
analytics candidate. It uses disposable Node SQLite databases and synthetic
code/control evidence. It is **unreviewed-local** until an exact frozen manifest
is reviewed separately. It does not admit a hosted operation, inspect a live
resource, use credentials, deploy code or enable production controls. Current
protected operations remain governed by
[production operations](./production-operations.md) and
[release migration rehearsal](./release-migration-rehearsal.md).

## Closed local profile

[The new module](../../apps/worker/scripts/maintained-analytics-forward-migration.mjs)
is independent of existing-role and typed-forward closed profiles. Their plans,
constants, caps and interrupted journals are preserved.

The only pending suffix is source ingestion isolation **0014–0016**, followed
by analytics **0034–0048**: three source and fifteen target files. It admits
no arbitrary SQL from a plan, replacement migration name, skipped step or later
suffix. Preparation reads the candidate's canonical migration directories using
the reviewed production schema directory order and installed Wrangler splitter.
It projects complete SQLite schema and operator-ledger digests for both databases
after each step: 19 joint frontiers. Trigger replacements are represented by
actual SQLite execution, not by an additive-object approximation.

All predecessor and pending input bytes participate in the preparation digest.
The closed local plan records every pending file hash, file byte count,
individual parsed statement byte counts and complete SQL-plus-ledger request
byte count. Code hashes and synthetic target names are explicit inputs; no older
operator predecessor commit or live resource identity is inferred. Every resume
recomputes the plan against current candidate bytes. Each submission rechecks
input hashes, both schema/ledger frontiers, code, controls and retained data.
A changed candidate requires a fresh reviewed local preparation.

The **512KiB** SQL cap belongs only to this local diagnostic. It does not change
existing 240KiB file or 256KiB transport caps. Local SQL transaction acceptance
cannot establish hosted request acceptance. Per-statement and complete-request
size are distinct measurements and must be reconciled with the exact provider
and pinned transport before online use.

## Local entrypoints

From the repository root:

```sh
node apps/worker/scripts/maintained-analytics-forward-migration.mjs inspect
node apps/worker/scripts/maintained-analytics-forward-migration.mjs rehearse
node --test apps/worker/scripts/maintained-analytics-forward-migration.check.mjs
```

`inspect` reads candidate SQL and projects disposable schemas. It prints bounded
content-free metadata with `status: unreviewed-local` and
`hostedAcceptance: unqualified`. `rehearse` creates private local qualification
journals under a new temporary directory, migrates both disposable databases,
then rehearses activation and fallback using synthetic role evidence. It prints
local results only. Other modes and additional arguments, including remote,
account, credentials, deployment or production flags, are refused.

The injected APIs are `prepareMaintainedAnalyticsForwardLocal`,
`createMaintainedAnalyticsSQLiteAdapter` and
`runMaintainedAnalyticsForwardLocal`. The runner defaults to planning and
requires the exact local confirmation and plan digest before synthetic mutation.
The concrete adapter creates only in-memory SQLite databases. There is no
production CLI, network adapter or provider implementation in this package.

## Atomicity and recovery

Each exact migration and its bound `d1_storage_migrations` append share one local
transaction. Execution uses the pinned Wrangler-split statements, matching the
D1 batch and its schema representation; the original file hash remains pinned.
Foreign keys are checked before commit. A late SQL failure rolls
back schema, data and ledger together; earlier committed migrations remain.
The private operation journal reuses the maintained release-operation mutex,
fsynced JSON, input binding and ownership/path checks. Its kind is
`qualification`, distinct from existing production journals. Each phase saves
the exact plan as a private, fsynced, no-clobber `plan.json`; resume binds that
file and the operation digest to the supplied original plan.

Before every migration/control submission, the runner durably records an
uncertain intent. A lost response or interrupted invocation remains uncertain.
Resume first performs read-only reconciliation against both databases and the
complete worker/control vector:

- Exact after frontier: applied; the step can be acknowledged without replay.
- Exact before frontier: not applied; retry needs separate explicit approval.
- Any other schema, ledger or control combination: ambiguous; stop and preserve
  the journal. No replay, schema downgrade, ledger relabel or data wipe is offered.

Continuation requires the digest of the exact reconciliation result. An
unapproved resume performs no mutation. A complete journal is checked against
its exact final frontier before returning idempotent completion. A journal
cannot be reused for another plan or phase.

## Code, schema, activation and fallback order

Migration requires all three feature flags disabled across the four named
synthetic roles, with every code digest equal to the plan's explicit code pins.
This packages the compatible-code/disabled-control prerequisite; it does not
deploy code or prove that old live invocations have drained.

Activation is a separate journaled phase, admitted only after both databases
match the complete final schema and ledger frontier. Its local ordering is
analytics producer, cache, publication, then public consumers. Each role's three
flags change together. Interrupted control changes use the same exact
before/after reconciliation contract.

Fallback reverses that order: public consumers, publication, cache, then
analytics producer. It can begin from a partial valid activation vector. The
runner preserves every schema, ledger and original predecessor-row digest
throughout. It offers no destructive database rollback. Deploying an older
binary remains a separate operation requiring proof that it understands current
schemas, authority, erasure/restore and durable state.

The adapter's retained-data proof covers all predecessor application tables,
original columns and sorted row hashes, including binary values. Its synthetic
stored graph result is retention evidence, not a native recomputation or a live
last-good serving proof. The separately named
[populated D1 rehearsal receipt](../receipts/2026-10-01-maintained-analytics-migration-local.md)
records native publication/readback and recovery assertions for its earlier
exact tested bytes; those results are not transferred to this changing candidate.

## Exact transport preparation and local proof

[The transport candidate module](../../apps/worker/scripts/maintained-analytics-forward-transport.mjs)
serializes the same split statements as one `{batch: [...]}` request per
migration, with a bound ledger insert last. It reuses the local operator's
frontier, code/control, retained-data and uncertain-intent journal checks. Its
profile remains `unreviewed-candidate` with `hostedAcceptance: unqualified`;
execution accepts only a credentialless injected synthetic backend and mock
fetch. There is no default network fetch, credential discovery or hosted mode.

The ordinary body cap remains 256KiB. The only exception binds exact source0015
file, hash, serialization length and body digest: **273,935 bytes**, **130 batch
entries**, body SHA-256
`d3e365e19ae62a3d351dda95626cd395bab8b8ebb0055e8cc1a958efdf99a820`.
Statements are individually capped at 8KiB in this candidate transport. Existing
closed profiles and global caps are unchanged. Responses are bounded at 2MB
with an independent request/response deadline of at most 20seconds. Uncertain,
malformed, conflicting, oversized or lost responses require read-only journal
reconciliation; no implicit retry is admitted.

Local checks cover all 18 migrations and uncertain continuation. An actual local
D1 batch test covers the exact130-entry source0015 request: commit, late-failure
rollback and final duplicate-ledger rollback. These results do not establish
hosted REST atomicity, body acceptance or retained-data index build duration.
Those remain exact, separately authorized online qualification gates.

## Remaining qualification

A later frozen manifest review must bind final SQL, operator/code bytes and
meaningful synthetic execution evidence. Online packaging then needs separately
authorized exact live role/database inventory, deployed predecessor ledgers and
schema variants, immutable code pins, backup/deletion-ledger posture, shared
production lock, bounded provider/transport acceptance, uncertain provider
terminal-status reconciliation and containment. This local package supplies none
of those observations or permissions. H06, H07, the combined Worker gate and
production cutover remain open until their owning evidence exists.
