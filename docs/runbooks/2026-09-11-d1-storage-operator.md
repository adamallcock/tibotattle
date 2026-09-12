---
title: Wrangler typed storage operator
date: 2026-09-11
type: runbook
status: local-implementation-only
---

## Boundary

These commands operate the new typed-storage workstream. They do not replace
the [production operations authority](production-operations.md), migrate existing
production data automatically, or certify the application cutover. Follow the
[implementation plan](../plans/2026-09-11-d1-typed-storage-isolation.md) and the
[schema boundary inventory](../research/2026-09-11-ingestion-analytics-schema-map.md).

Every database has a **9,000,000,000-byte operating budget**. The operator checks
measured bytes plus the approved migration growth allowance before admission,
and rechecks actual size afterwards. This is an operational budget, not a
Cloudflare-enforced quota or a guarantee against concurrent growth. Resource
creation, schema migration, evidence copy and runtime activation remain separate.

## Local checks

From `apps/worker`:

```sh
npm run storage:scripts:check
npm run storage:test
npm run typecheck
```

The tests use disposable local D1 databases. They exercise exact typed/legacy
record reconstruction, owner-scoped private dictionaries, replay, copy into a
nonempty namespace, atomic copy checkpoints, isolated analytics delivery and
owner-move write fences. The fresh-target composition also exercises accountless
HTTP enrollment/ownership, upload claims, typed staging and exact domain closure,
isolated analytics outage/recovery, opt-out and owner erasure. This composition
uses the optional `ingestion-bridge-migrations` and
`typed-v11-admission-migrations` after the baseline and typed layouts; the authority restore rehearsal additionally builds the complete role-specific
reference and verifies the generated fresh restore-base SQL before packaging. Tests do not
qualify production HTTP admission, distributed erasure, or a full restored
analytical publication.

The source-copy fixture uses the existing full `0001`–`0060` schema and actual
credential/chunk repositories. It retains staged v1.1 records and all three
streams. A second pass compares exact records and membership; changed source
evidence refuses verification. Neither a checkpoint nor an end-of-page result
asserts that a mutable source was a consistent snapshot. The final operator must
hold the source write fence through complete copy and verification, including
authority, manifests, receipts and deletion-ledger reconciliation.

## Plan inspection

```sh
npm run storage:plan -- \
  --plan /absolute/private/storage-plan.json \
  --worker-root /absolute/checkout/apps/worker
```

This default path performs no remote operation, authentication or lock mutation.
The closed `d1-storage-plan-v1` input identifies the exact account, environment,
reviewed source commits, operation UUID, expiry, phase and target set. Its maximum
32 targets each have a role, name, binding, database ID, qualification hash and
growth budget. Creation can use a null ID only for the exact operation-specific
new name. Migration requires the ID returned by the provider; names alone never
authorize an existing database.

Role directories are:

| Role | SQL directory | Runtime purpose |
|---|---|---|
| ingestion | `.release-build/ingestion-role-migrations` | Qualified fresh restore base; complete authority/control/typed/admission/bridge/isolation reference is separately hash-bound |
| analytics | `analytics-migrations` | All ordered delivery, projection, publication, history and retirement migrations; qualification must include the complete current inventory |
| control | `routing-migrations` | Owner placement and move catalog; never an authorization substitute |

Each directory must have source-bound `qualification.json` and
`qualification-evidence.json` generated after the reviewed source is frozen.
Qualification pins every ordered SQL file, before/after schema fingerprints and
evidence hash. These receipts must describe completed qualification; do not write
`qualified` merely because empty tables can be created. Ingestion qualification has the explicit scope `restore-base-schema-only` and
`runtimeReady: false`; it does not authorize cutover. Other role qualifications
remain absent until their actual complete runtime gate passes.

## Authorized execution and uncertain outcomes

Execution requires `--execute`, `--confirmation EXECUTE_REVIEWED_D1_STORAGE_PLAN`,
the exact `--approved-plan-sha256` printed for the reviewed plan, the repository
root, a private operation directory and the pinned Wrangler CLI path. The
maintainer's authorization must cover the exact environment and operation.

The operator takes the existing shared production deployment lock and writes a
durable intent before each external action. It records provider-assigned resource
IDs and schema results. An unclear response retains ownership and the journal;
it does not issue another create or migration blindly. An explicit `--resume`
reconciles exact resource identity and before/after schema receipts. Unexpected
IDs, hashes, capacity, SQL or owner state stop execution. There is no automatic
database deletion or automatic application cutover.

An expired exact plan can still reconcile observations and release ownership
after verified completion. It cannot authorize another database write. Likewise,
an unexpectedly oversized completed migration can be inspected and reported as
`completed-over-budget`; the tool refuses further migration admission rather
than hiding the bytes or making recovery impossible. The migration ledger's
own schema and attached objects are verified before receipt writes, and API
origin/environment overrides are rejected by the fixed Cloudflare transport.

To continue an expired partial operation, obtain approval for a separate
`d1-storage-approval-extension-v1` document and pass it with `--resume`,
`--extension /absolute/private/extension.json` and
`--approved-extension-sha256 <approved canonical digest>`. Its fields are
`schema`, `planSha256`, `previousExtensionSha256` (null for the first extension),
`approvedAt` and `expiresAt`. The renewed window is at most 24 hours. Each
extension links to the previous approved digest and stays in the original
journal; it cannot change the operation, owner, source, target IDs or schemas.
The tool reconciles a pending effect before issuing further writes. Replaying
an old extension does not reset its deadline, and renewal never reacquires a
missing lock. No extension is generated or approved automatically.

Provision replacement ingestion and analytics separately. Keep the original
full database and independent deletion ledger. Activate the new binding only
after complete preservation, public withdrawal fences, retry/erasure tests and
the live canary are proven. Later ingestion shards need stable owner placement
and fenced whole-owner moves; filling a database does not authorize redirecting
individual records to the next one.


## Executable local restore preparation

Use the Worker checkout and its pinned Node/dependencies. This default inspection
reads local source and SQL only. An in-progress checkout requires the explicit
local rehearsal flag; it cannot emit qualified metadata.

```sh
node scripts/d1-storage-restore.mjs --worker-root "$PWD" --allow-unfrozen
node scripts/d1-storage-restore.mjs --worker-root "$PWD" \
  --rehearse --allow-unfrozen --directory /absolute/new/private/rehearsal
npm run storage:scripts:check
```

Supported restore input is the reviewed raw legacy schema copied into a fresh
typed target. An already-typed or diverged source is not implicitly accepted;
its journal/incarnation and retained erasure epochs need explicit reconciliation.
No code resets or advances those epochs merely to fit the restore fixture.

The directory must be new, canonical (use `/private/tmp`, not its `/tmp` alias
on macOS), owner-private and unlinked. The rehearsal uses synthetic source data
and real local D1 batches. It preserves the source, copies authority/receipts and
typed evidence in bounded pages, adopts exact original IDs and digests, performs
independent second-pass verification, installs the full final role, and completes
bounded retained-owner discovery. It separately executes the emitted restore-base
SQL in a fresh D1 database and checks its exact schema.

A mandatory subsequent rehearsal uses restored credentials and accepted chunk
receipts, accepts a new upload, drains a separate analytics database, checks exact
daily values, opts out and physically erases the synthetic target owner. An
independent deletion ledger also suppresses a previously tombstoned restored owner;
the original source remains unchanged. `restored-runtime-evidence.json` records
this gate separately and its hash is bound by `qualification-evidence.json`.
Public graph qualification, real-source reconciliation and runtime cutover remain
separate gates. Accountless tombstone replay revokes enrollment before claiming
the digest-bound `restore-replay:` deletion fence; other operation fences are
refused, exact interrupted replay can resume, and social replay retains its NULL
fence. Original owner-shape and deletion guards remain authoritative.

After the reviewed application and operator source is committed and clean, run:

```sh
node scripts/d1-storage-restore.mjs --worker-root "$PWD" \
  --rehearse --qualify --directory "$PWD/.release-build/ingestion-role-migrations"
```

This creates `qualification.json`, `qualification-evidence.json`,
`0001_restore_base.sql`, the exact `final-role-schema.json`, and `role-inputs.json`.
The six ordered input directories are baseline migrations, typed ingestion,
ingestion bridge, typed v1.1 admission, typed v1 admission, and ingestion isolation.
The target contract additionally binds the exact `d1_storage_migrations` table
and its ordered row digest. This small operator receipt ledger is preserved and
rechecked at finalization; it is not treated as telemetry or ignored as arbitrary
nonempty target state. The final role reference is retained as `final-role-reference.sql.txt`; it is not
an extra remotely executable migration. Never deploy the full reference before
restore: fresh-enrollment guards must not reinterpret historical expired/revoked
authority as a new enrollment. Never use typed-core tables alone as the role.

## Temporary migration Worker

`d1-storage-migration-package.mjs` packages the same reviewed APIs with one exact
contract embedded in the bundle. Prepare an actual operation contract only after
source snapshot/write-pause and fresh target/base identities have been qualified;
the synthetic rehearsal contract is never an actual source-copy approval.

```sh
node scripts/d1-storage-migration-package.mjs --worker-root "$PWD" \
  --contract /absolute/private/restore-contract.json \
  --contract-sha256 <reviewed-canonical-contract-digest> \
  --expires-at <reviewed-ISO-UTC-deadline-within-24-hours> \
  --directory /absolute/new/private/migration-worker
node node_modules/wrangler/bin/wrangler.js deploy --dry-run \
  --config /absolute/private/migration-worker/wrangler.jsonc \
  --outdir /absolute/new/private/migration-worker-dry
```

`--allow-unfrozen` permits a local-only package check; that bundle refuses enabled
execution even if its environment variable is changed. The generated config has
placeholder database IDs, no cron, no public route, and disabled mode. Actual
binding changes, deployment and schedule activation require the exact reviewed
operator approval. Its `fetch` always returns 404. Enabled scheduling enqueues a
fixed contract/stage/step wakeup. One Queue message performs one bounded native D1
page and sends the next wakeup only after committed progress; cron recovers lost
wakeups. No source records enter messages. Configure maximum batch size 1,
concurrency 1 and retries 0, following the [Queue batching and retry contract](https://developers.cloudflare.com/queues/configuration/batching-retries/).
Each API retains its atomic `batch`; prepared statements are never interpolated
into Wrangler SQL.
The `_authority_operator_progress` target table retains contract, stage, count and
intent; concurrent invocations cannot claim the same page. A lost response leaves
intent set and subsequent Queue messages and schedules refuse work. Inspect the exact restore/copy
receipts and reconcile explicitly; do not clear intent or retry a write blindly.

The temporary Worker does **not** reconcile the independent deletion ledger or
switch production routing. A source write fence is not proof against privileged
DDL or out-of-band writers: the external snapshot/write-pause protocol remains
mandatory. Keep ordinary target traffic unbound through authority/typed/bootstrap
verification, deletion-ledger reconciliation, independent analytics catch-up and
actual HTTP/privacy/erasure/public-response qualification.

### Optional private placed execution

The default remains the single Worker described above. The optional placed mode
keeps Queue and Cron ownership in a front Worker and sends one bounded private
request to a backend which runs the **entire unchanged** journal claim, restore
step and progress commit. Only after a validated response does the front publish
the next Queue wakeup and acknowledge the current one. The backend has no Queue
producer or Cron. The front has no D1 bindings. This uses
[Service binding fetch](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
and [region placement](https://developers.cloudflare.com/workers/configuration/placement/);
placement affects the backend fetch, not the Queue handler, and does not guarantee
execution inside the named cloud provider.

Supply a private closed `d1-storage-placed-topology-v1` JSON document containing
`frontName`, `backendName`, `queueName`, the exact 32-hex `queueId`, `source` and
`target` each with exact `name` and UUID `id`, and `region: "gcp:us-east4"`.
Names and IDs must be distinct where required; unknown fields and other regions
refuse. This prepares files only; it does not discover or create resources.

```sh
node scripts/d1-storage-migration-package.mjs --worker-root "$PWD" \
  --contract /absolute/private/restore-contract.json \
  --contract-sha256 <reviewed-canonical-contract-digest> \
  --placed-topology /absolute/private/topology.json \
  --placed-topology-sha256 <reviewed-canonical-topology-digest> \
  --expires-at <reviewed-ISO-UTC-deadline-within-24-hours> \
  --directory /absolute/new/private/placed-migration
```

The package contains `migration-worker.mjs`/`wrangler.jsonc` for the front and
`migration-backend.mjs`/`wrangler.backend.jsonc` for the backend. Both are disabled
with empty schedules, no routes, workers.dev or preview ingress. Preparation pins
the actual source commit, role input digest, both bundle and configuration hashes,
and exact topology. An execution digest binds the source, role, contract, deadline
and topology inside both bundles and every private response. The original Queue
message remains unchanged. Private request and response bodies are capped at 2KiB;
errors are content-free and never authorize a retry.

Review both dry builds and actual uploaded versions, exact D1/service/Queue
bindings, ingress closure and backend placement before activation. Journal every
external mutation. Activate the pinned backend before the front; attach the front
consumer and schedule only in the approved window. An expired deadline cannot be
renewed by editing configuration. Before-effect failures, lost responses and
pending intents need the existing stopped-executor reconciliation, not retries.
A backend commit followed by lost fetch response or Queue send is a safe lost
wakeup: Cron obtains the committed next step. An unknown effect before progress
commit retains the intent and refuses further execution. Never clear it on a
fetch timeout. Detach the front consumer and schedule before cleanup, then verify
both Workers absent and preserve the exact retained database inventory.

For local populated proof using actual restoration APIs and native Queue/Service
bindings (no cloud placement measurement):

```sh
node scripts/d1-storage-restore.mjs --worker-root "$PWD" --rehearse \
  --transport placed --records 1600 --directory /absolute/new/private/placed-proof
```

This existing fixture retains 1,600 v1.1 usage records and also executes the
restored-runtime credential/replay/catch-up/withdrawal/erasure proof. It does not
claim mixed-stream or v1 workload coverage. The separate dense cloud rehearsal
must retain both 1,600-row v1 and v1.1 fixtures (800 usage, 600 quota, 200 sessions),
verify all four copy/adoption/verification passes, final proof counts, foreign
keys and full unchanged source census, and retain per-stage timing and unknown
outcomes. Use fresh isolated resources and the **new frozen source** role packages;
never relabel earlier source qualification. Unchanged migration/schema hashes
are parity evidence only. The small synthetic 19-stage driver test proves
transport/CAS/ack behavior, not record preservation or cloud throughput.

### Explicit continuation into another window

`d1-storage-migration-continuation.mjs` prepares a new disabled placed package;
it never stops, deploys, resumes or reconciles a Worker itself. Keep the original
source checkout clean and available. The new package must retain its exact source
commit, role input, contract, source snapshot and resource topology. A newer
tooling checkout may run this helper against that original `--worker-root`; this
does not authorize changing the restoration code mid-copy.

First remove the prior front schedule and Queue consumer, disable both versions,
and retain the actual version/deployment/settings, ingress and consumer readbacks.
Quiet tails, an expired deadline, a running tail process or `intent: null` do not
prove that every old invocation finished. Stopping ingress is operational hygiene;
the atomic target execution fence below is the ownership boundary. No continuation
clears an intent.

The closed `d1-storage-migration-handoff-v1` input binds those evidence file hashes
to the prior preparation/execution digest, stopped versions, source/target IDs,
stop/observation times and clean target checkpoint including its execution digest. Its observation must be
at most 15 minutes old. The helper parses the raw provider responses and bounded
SQL results itself: exact frozen source schema/triggers/snapshot/sequences and
the unchanged target journal DDL/contract/stage/step with `intent: null`. Use the
five exported `MIGRATION_CONTINUATION_READ_SQL` statements and retain each exact
query hash alongside its result hash. All files must be private regular files;
the closed input fields and evidence names are defined by
`validateMigrationHandoff` in the maintained helper.

The separate closed `d1-storage-migration-continuation-approval-v1` document has
`originalPreparationSha256`, `previousPreparationSha256`,
`previousContinuationSha256` (null for the first continuation), `handoffSha256`,
`approvedAt` and `expiresAt`. Record the existing authorization explicitly for
this window; approval is never inferred from time passing. The new expiry must
extend the prior deadline and be no more than 24 hours after approval. Pass the
reviewed canonical approval digest explicitly; preparation and handoff hashes
are hashes of their retained file bytes.

```sh
node scripts/d1-storage-migration-continuation.mjs \
  --worker-root /absolute/original-clean-checkout/apps/worker \
  --previous-directory /absolute/private/prior-package \
  --previous-preparation-sha256 <prior-preparation-file-sha256> \
  --contract /absolute/private/restore-contract.json \
  --handoff /absolute/private/stopped-handoff.json \
  --handoff-sha256 <handoff-file-sha256> \
  --approval /absolute/private/next-window-approval.json \
  --approved-approval-sha256 <reviewed-canonical-approval-digest> \
  --directory /absolute/new/private/next-window
```

The fresh directory contains `package/` and retained input hashes. Its new
`continuation.json` links both executions and the prior continuation receipt and
pins `rollover.sql`. Review and execute that **single** target statement explicitly
before enabling the new pair. It changes only `execution_digest`, requiring the
exact old execution, contract, stage, step, null intent and owned journal DDL. It
also refuses after the approved new deadline. One returned row is required;
anything else stops. A lost response never authorizes another write: use the
exported read-only `migrationRolloverDisposition` with a fresh exact journal row
to distinguish the unchanged old owner from the exact new owner. An unexpected
stage, step, intent or digest remains unresolved.

Both claim and commit compare the execution digest atomically. An old invocation
paused before its claim cannot write after rollover. An invocation which already
claimed work keeps its intent and prevents rollover. The new package declares
`executionFenceVersion: 1`; legacy unfenced journals/packages are refused without
an automatic upgrade. This changes only the temporary operator journal, not the
restoration contract or ingestion schemas.

Preserve every prior package and failure. Repeat the existing dry-build, version,
binding and ingress checks before explicitly activating the new pair. Existing
Queue messages remain compatible; the original journal determines the next step.
Before cutover, pin the **final** approved package execution digest in the closed
cutover plan's `proof.migrationExecutionDigest`. Both pre-analytics and full
admission require the fenced journal DDL and that exact terminal execution;
the final read repeats this ownership check. A prior window digest, missing pin
or legacy journal cannot qualify, even when record counts and schema checks pass.
The local two-window test uses native D1 and the maintained journal/driver with
small synthetic copy APIs. Actual populated cloud rollover remains a separate
rehearsal: expire after a committed page, prove the stopped handoff, explicitly fence ownership and
activate the linked window, then verify all copied cells and unchanged source.

## Separate analytics Worker

`wrangler.analytics.example.jsonc` points at the maintained separate scheduler.
It contains only placeholder IDs, `STORAGE_ANALYTICS_MODE: disabled`, no routes
and no cron. Check its bundle locally without provisioning anything:

```sh
node node_modules/wrangler/bin/wrangler.js deploy --dry-run \
  --config wrangler.analytics.example.jsonc \
  --outdir /absolute/new/private/analytics-worker-dry
```

Enabled scheduling also requires the exact `DELETION_LEDGER` binding for automatic
erasure-job cleanup. Its forward ledger migrations and analytics cleanup receipt
migrations must be separately qualified; an ingestion-only deletion claim is
insufficient. The template provides a third placeholder ID, never a real ledger.

The actual analytics role qualification must pin **every** current ordered SQL
file, including reusable day values, paged model values, graph publication,
retirement and history checkpoints. It cannot reuse a foundation-only receipt.
Source namespaces, source IDs and real bindings belong to the reviewed operation.
The restore contract pins `sourceId` independently from the lossless typed
`sourceNamespace`; the latter is validated by the existing typed codec, not
shortened, normalized, or reused as the journal identifier.

Legacy v0.2 remains an allowance-fit input, not a new daily-activity cohort.
For an already-active owner, distinct-dataset header insertion and recognized
header accounting/count completion emit `source-updated`; exact input revisions
still invalidate future computations. Overlapping occurrence membership hard-
invalidates the public graph in the same batch. Same-dataset, identity, policy or
unknown metadata changes retain the hard authority transition; raw repairs and
deletions retain the hard graph fence. Initial owner activation stays
`owner-active`. No per-record outbox or fabricated daily values are introduced.


## Disabled staging preparation

Generate a reviewable package without creating resources or enabling collection:

```sh
node scripts/d1-storage-staging-preparation.mjs --worker-root "$PWD" \
  --directory /absolute/new/private/staging-preparation
```

During local development only, add `--allow-unfrozen`. The package deliberately
leaves approval, source snapshot, resource IDs and qualified receipt pins unfilled.
It describes two fresh databases (ingestion and analytics), the existing independent
deletion ledger, retained R2 reachability and one temporary migration Queue. No
routing/control database is required for this first staging path. App and analytics
config fragments remain disabled with no routes or schedules. The source pause,
ledger reconciliation and resource plan templates must be bound to exact reviewed
resources before any separately authorized provider action; an empty replacement
ledger is forbidden. Synthetic canary approval is a separate operation boundary.

## Whole-role measurement

A bounded synthetic v1.1 usage workload can measure the actual complete role:

```sh
node scripts/d1-storage-restore.mjs --worker-root "$PWD" \
  --rehearse --allow-unfrozen --records 10000 \
  --directory /absolute/new/private/whole-role-measurement
```

The hard workload limit is 10,000 records. The receipt records actual D1
`meta.size_after` for empty/populated baseline, empty full reference role, and
populated final target. Target allocation includes retained authority, manifests,
receipts, typed data, admissions/proofs, indexes and restore journals. It excludes
the separate analytics database. Allocation is captured before the synthetic
runtime canary mutates the target; `restoreElapsedMs`, `runtimeElapsedMs` and
`elapsedMs` distinguish the two stages. The fixture has one data owner and one
empty tombstoned authority owner. These usage-only results must not be
presented as mixed-stream, fleet or production capacity; actual preserved-row and
bootstrap checks must pass before the result is reported as measured. A changed
source or interrupted operation yields no passing qualification receipt.
