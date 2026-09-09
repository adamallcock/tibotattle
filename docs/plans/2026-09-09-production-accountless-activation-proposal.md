---
title: Production accountless contribution activation proposal
date: 2026-09-09
type: plan
status: proposed
---

# Scope and evidence

Prepare production collection for the accepted [Electron sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md). This proposal authorizes no remote write, credential renewal, migration, deployment, public admission, or release publication. Public health was read on 2026-09-09: deployment `32cd6317622c9aef9b7bf015b376b4cdb93c91fc`, operational collection with enrollment/upload registration/processing/publication enabled, and passing reported storage/lifecycle checks. This endpoint does not expose accountless mode fields. A read-only production ledger observation at `2026-09-09T18:10:17.308Z` found primary migrations 0001–0056 applied and deletion-ledger migrations 0001–0002 applied. Read-only deployment and secret-name inspection at 18:19 UTC confirmed both accountless mode variables are absent (therefore disabled), collection revision 1 is operational with all four stages enabled, and all five required secret names are present and bound. No secret values were read. The credential-free observation is retained in the private qualification artifact directory.

The [Electron readiness record](2026-09-05-electron-release-readiness.md) records the signed staging pass: automatic accepted upload, authenticated restart with retained installation binding, and persistent opt-out. The separate signed untouched-install run [34386204318](https://github.com/adamallcock/tibotattle/actions/runs/34386204318), using runner `e33c6b37` and signed app `c0c98040`, also passed: the real native introduction was completed and the app created default-on sharing without a seeded preference or acknowledgement. The three-visible-notice transition has focused source/composition evidence; no seven-day signed migration run is claimed.

Enrollment, upload ownership, encrypted v1.1 transport, renewal, scheduling, opt-out fencing and installation-scoped replay protection are implemented. Production configuration still omits both accountless mode flags, whose server defaults are disabled. Public selectors explicitly exclude accountless owners. The older September 4–5 integration/migration proposals are historical, not the current implementation boundary.

# Observed migration admission and local result

The exact pending primary set from that production observation is:

| Migration | Reviewed SQL SHA-256 |
|---|---|
| `0057_accountless_enrollment_ledger.sql` | `5cbf718449688bffc0fc5cf63d1de17351acb915f44459f1b32f3202c7378cd5` |
| `0058_accountless_upload_ownership.sql` | `b435fd92d41e7ce8067cc183d7ac153359a9c130a971cba2e1b8b8c1c9cab61b` |
| `0059_accountless_upload_renewal.sql` | `98afb99dd91e56a96960e6d99096e44c41eec0cd52d5a1e2969dea4ddee3d312` |

No deletion-ledger migration is pending. The observation queried only migration
names, not production telemetry. D1's names-only ledger does not attest the
historical SQL bytes; final admission must recheck the prefix and retain the
existing deployment evidence.

The contained local gate passed with 1,000 synthetic accounts, 100,000 records
in each of the two telemetry tables, a 50% heavy-source skew and a 336-day
observation span. Each pending migration passed interrupted-transaction rollback,
forward preservation, foreign-key and integrity checks; replay performed zero
writes. The primary ledger reached 59 entries and deletion ledger stayed at 2.
Elapsed time was 16.953 seconds, peak reported RSS 120,848,384 bytes, primary
SQLite size 151,183,360 bytes, and deletion SQLite size 749,568 bytes. Node was
26.2.0 with SQLite 3.53.1 on Darwin arm64. The external watchdog confirmed owned
process termination. These are synthetic local resource observations, not
production-size or Cloudflare execution guarantees.

A subsequent maintained D1 metadata observation at
`2026-09-09T18:46:56Z` reports a **5,328,384,000-byte primary database** and
49,152-byte deletion ledger. The primary is about 35.2 times the local
151,183,360-byte fixture database. The owner-only `database-size-metadata.json`
receipt contains sizes only, without database IDs or records. Exact record
counts were not queried: scanning the live database was unnecessary for this
bounded intake. Since 0058 snapshots and rebuilds many populated tables, the
current 100,000-records-per-table test does **not** establish production-scale
time or temporary-storage admission. Prepare a representative larger local
scale/peak-storage rehearsal and assess the provider migration/storage limits
before approving that live rebuild; do not infer row count, execution time or
available headroom from total byte size alone.

Private owner-only evidence is retained under
`production-activation-preparation-20260909/` in the qualification artifact
root: `production-prefix.json`, `migration-admission.json`, and
`local-populated-rehearsal.json`. The receipt binds prefix digest
`1106b1641acc84885b5e4680f7bf9a46cc988dd3038af582683973c23fc663d1` and full
migration-inventory digest
`1d50458ac1006c9de7b26c312df61d992ff28b709624742bbcafdc5790babc99`.
It explicitly records `freshness: supplied-snapshot-not-live`,
`remoteSyntax: not-exercised`, and `productionReadiness: false`. No production
migration, remote syntax write or deployment was performed.

# Migration 0058 admission and simpler alternatives

Source review found 52 ordinary main-database snapshot tables created with
`CREATE TABLE ... AS SELECT`, not SQLite temporary tables. The snapshots coexist
with the original rows before the participant/device roots are dropped. Their
foreign-key cascades clear descendants; explicit deletes clear non-cascading
sources. All 52 snapshots are restored while the copies remain present, then
removed. Root indexes are recreated, and retained descendant indexes must be
updated during replay. One interrupted transaction must preserve the original
schema, authority and every retained row.

Capacity is a risk, not a demonstrated overflow. The metadata size includes an
unknown mixture of table/index allocation and free pages; the read-only intake
did not establish their proportions. Snapshot tables do not copy source indexes
or constraints, and reusable free pages can reduce file growth. A simple
`2 × 5.33 GB` calculation is therefore not a measured peak. Conversely, assume
neither spare pages nor a particular index/data ratio when approving the rebuild.
SQLite documents the distinct CTAS layout and its free-page accounting in
[CREATE TABLE](https://www.sqlite.org/lang_createtable.html#the_create_table_command)
and [PRAGMA freelist_count](https://www.sqlite.org/pragma.html#pragma_freelist_count).

The local receipt went from 109,506,560 bytes after 0057 to 151,183,360 bytes
after 0058, about 1.38× for that synthetic distribution. This is a file-size
observation, not a universal peak factor or a journal/WAL allowance. Its 5,535 ms
0058 step includes interruption/rollback, forward execution and preservation
checks; it is **not** a pure migration duration. The maintained harness currently
caps each database at 1 GiB and one million events per telemetry table, so it
cannot claim a 5.33 GB qualification unchanged.

Cloudflare specifies a 10 GB per-database maximum, which cannot be raised, and
30 seconds for a SQL query/API batch. Its guidance recommends batching large
data modifications. The pinned Wrangler `migrations apply` implementation sends
each entire migration plus ledger append to the `/query` path; it does not use
the asynchronous file-import path. Both capacity and total-call duration require
admission. The 5 GB file-import limit concerns the uploaded SQL file, not this
existing database's size. These are current provider limits, not timings inferred
from the local Mac. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [import behavior](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

A simpler schema operation now exists in upstream SQLite:
`ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` was introduced in 3.53.0 on
April 9, 2026. It passed a tiny synthetic local check with our Node SQLite3.53.1.
That does not prove deployed D1 support. Production's constant-only
`SELECT sqlite_version()` and a strictly prefixed `EXPLAIN ALTER TABLE ...`
were refused by the authorizer; neither executed DDL. The local pinned
Miniflare feature probe stalled without evidence and its owned processes were
terminated. D1 release notes do not establish this feature. The private
`d1-alter-capability-intake.json` and `d1-alter-explain.json` keep those limits
explicit. See [SQLite ALTER COLUMN](https://www.sqlite.org/lang_altertable.html#altertabaltercol)
and [EXPLAIN semantics](https://www.sqlite.org/lang_explain.html).

The subsequently authorized one-row probe in the existing isolated staging D1
verified the configured/live staging identity, created a fresh uniquely owned
table and attempted the actual `ALTER COLUMN ... DROP NOT NULL`. D1 refused it
with `not authorized` / `SQLITE_ERROR`. The probe dropped only its new table and
verified absence; production and existing staging tables were untouched. The
owner-only `staging-alter-not-null-feature.json` records the capability failure
and successful cleanup at `2026-09-09T19:00:14Z`. This is not a production or
full-migration rehearsal. It establishes that the desired operation is not
usable through the current hosted D1 route; it does not identify the engine
version or justify bypassing the authorizer.

The bounded options and current recommendation are:

1. **In-place changes: currently unavailable.** The tiny hosted check above
   refused the necessary operation. If Cloudflare subsequently exposes it,
   prepare an equivalent candidate using additive owner columns, nullable social
   fields, unique indexes and only necessary trigger/view changes. Compare full
   final schema semantics and populated preservation against existing 0058,
   then qualify the hosted transaction. Do not start that rewrite on the
   strength of the newer local SQLite alone.
2. **Next assess the unchanged migration's asynchronous file path.**
   Wrangler's maintained `d1 execute --file` uses an import job with polling;
   that may avoid the ordinary API batch's total-call limit, but does not prove
   exemption from individual-statement/resource limits. This is the smallest
   next qualification option, not approval to run the rebuild. Retain the exact SQL
   and ledger append together and qualify atomic failure recovery on a
   disposable database. Admit production only with measured temporary-storage
   headroom and hosted evidence for the largest snapshot/cascade/restore. Do
   not assume this route makes a multi-gigabyte statement safe.
3. **Use resumable bounded maintenance only if the above fail.** Reuse existing
   collection pause/revision, ownership fences, migration admission and recovery
   boundaries. A reviewed phase journal must bind predecessor/source hashes,
   immutable batch cursors, preservation evidence and cleanup; restart must
   resume the exact phase. The root drop/cascade itself must be bounded, so
   merely chunking snapshots leaves the original risk. This is more engineering
   than an in-place alteration and requires a source plan before implementation.
   A new production database is not the default response.

Do not silently replace 0058's provenance: it is pending in production but has
already run in isolated staging. Scoped Worker guidance requires forward-only,
reviewed migrations, and the source inventory/receipts bind their hashes. Keep
the current canonical file until an equivalent candidate, staging lineage and
explicit admission approach have been reviewed. Do not skip/relabel ledger
entries or edit `sqlite_schema` to make the gate pass.

No multi-gigabyte run was started. If a larger local rehearsal remains useful
after assessing the asynchronous route, extend the existing contained runner narrowly:
record actual migration execution time separately from preservation, observe
snapshot/restore page and journal peaks, retain the watchdog/RSS/page ceilings,
and require explicit scratch-disk headroom. At intake the local volume had
about 112 GB available; this is an observation, not a reservation. Propose a
single owned scratch directory with a 20 GiB total footprint ceiling, 2 GiB RSS
and ten-minute external deadline, stopping at the ceiling rather than hiding
it. A larger local pass can reject an unsafe plan but cannot replace the
hosted 30-second/transaction qualification.

# Asynchronous import assessment and tiny hosted proof

The installed Wrangler's `executeRemotely` uses `/import` for `--file`, with
an MD5-checked upload followed by ingest and bookmark polling. Its user-facing
contract warns that the database cannot serve queries while processing and
states that a failed import restores the original database state. This supports
investigating the unchanged SQL. The tiny hosted proof below exercises those
semantics; it does not establish the behavior of all 0058 statements or its
production-scale resource needs. The [import guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
requires omitting explicit transaction wrappers and supports deferred foreign
keys. Preserve the migration text and the same ledger append generated by
Wrangler in one file; do not split either around the import or add `BEGIN`.

The [import API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/)
documents init, ingest and poll, an in-progress bookmark and a final bookmark.
It reports duration and size **after** completion. It does not document a
whole-import duration ceiling, an exemption from individual-statement limits,
a cancellation action or peak storage. The pinned polling implementation has
no overall deadline or cancellation request. Stopping a local client therefore
does not prove that the remote operation stopped or rolled back. Resume status
observation for the same operation before any retry or cleanup; a locally
interrupted poll is an unknown outcome until the provider result and exact
schema/ledger readback agree. Do not infer import cancellation from the separate
export API's behavior.

No documented cheap live-data/free-page split was found: the
[D1 statement reference](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
does not list `page_count` or `freelist_count`, and the maintained metadata
surface supplies file size rather than those counts. No additional production
PRAGMA, table scan or export was attempted. The current 5.33 GB allocation and
unknown import peak remain an admission gap, not proof of insufficient space.

**Recommended next experiment:** qualify semantics first, at tiny synthetic
scale. On a specifically approved isolated target, use unique owned parent,
child and private marker tables, with a synthetic baseline committed before
import. The file should defer foreign keys, snapshot, cascade/rebuild and
restore, then append the private marker. Run one late intentional failure and
prove that the original schema/rows remain and the marker/copies do not; run
one successful variant and prove restoration, foreign-key integrity and exactly
one marker. Retain exact input hashes, terminal import status and closed
readbacks. Clean up only these owned tables after a known terminal outcome.
This proves route semantics, not production-scale timing or storage.

Even a tiny file can temporarily block the entire target database. Existing
session authorization for isolated staging synthetic work may cover this bounded
operation; the coordinator must assess the concrete scope and availability effect
against that authorization, rather than infer a new approval requirement from
the provider warning alone. The coordinator reviewed and authorized the exact
owned-table experiment below under that existing scope. A full exact 0058
rehearsal requires a fresh disposable database selected through the
maintained rehearsal admission boundary: existing staging already has 0058,
so do not reapply it there, rewrite its ledger or relax target checks. Prepare
0056 plus a synthetic fixture and 0057, then run exact 0058 plus its ledger
append through the file route. Creating a disposable target, if needed, is an
explicit operation in that proposal. Proceed to larger representative data only
if the tiny rollback/cascade test passes and the provider's statement/storage
limits can be admitted. This keeps the existing migration architecture and
avoids a new batching framework before it is shown to be necessary.

The concrete private preparation now exists at
`production-activation-preparation-20260909/import-semantics-plan/`: six immutable
SQL inputs, per-file SHA-256/size manifest, prior verified staging identity,
exact sequential commands, readback expectations and cleanup/interruption rules.
Its largest input is 1,849 bytes; the only baseline is one parent and two children
plus an empty private ledger analogue. A local synthetic transaction test passed
late-failure rollback, successful cascade/restore and exact-object cleanup.
The exact experiment subsequently ran on the existing isolated staging target.
Fresh configured/live identity separation passed; all four collection flags were
off at revision 14, and no relevant active hosted/local rehearsal was observed.
The final `execution-reconciled.json` receipt passed at
`2026-09-09T19:19:00Z`: the deliberate final UNIQUE failure restored the original
schema and all three synthetic rows with no marker or snapshots; the successful
import restored children before their parent under deferred foreign keys,
committed the expected schema and exactly one private marker, and passed the
foreign-key check. Its provider duration was 3.7459 ms. Exact cleanup verified
all five owned object names absent. No production, existing product table or
canonical migration ledger was changed, and no remote resource was created.

The first read-only metadata check returned an unclassified nonzero result;
its read-only retry succeeded without renewal. During the success import,
Wrangler emitted leading status text before its JSON suffix. The initial
parser failure is preserved in `execution.json`; dependent operations stopped.
The pinned terminal result (`success`, final bookmark and metadata) was then
validated from the unique complete JSON suffix and reconciled with exact
read-only schema/data checks before cleanup. Neither import was rerun. This
qualifies tiny hosted atomic failure/cascade/restore semantics only; it does
not close the 5.33 GB storage or largest-statement duration admission gap.

# Prepared exact-migration disposable experiment

The maintained remote rehearsal now has a narrow explicit
`--import-migration 0058_accountless_upload_ownership.sql` option, accepted only
for the reviewed primary 0056 / ledger 0002 predecessor. Its existing distinct,
forbidden-target and empty-pair checks remain mandatory. It uses the established
two-account/20-record fixture, applies 0057 normally, imports exact 0058 and its
ledger append together, then applies 0059 normally. It verifies original-column
synthetic row hashes, counts, foreign keys and final ordered ledgers. Completion
parsing accepts only known pinned upload progress plus a complete successful
terminal result. Uncertain mutations preserve the private generated inputs for
reconciliation and never authorize retry or remote deletion.

The source-focused suite passed 26 tests, including actual in-memory SQLite
routing/preservation, same-count row corruption, forbidden admission and malformed
terminal output. An independent read-only source review found no blocker. This
is source/local evidence; the new disposable resources do not exist yet.

The concrete owner-only inputs are in
`production-activation-preparation-20260909/disposable-import58-plan/`:
`OPERATION.md`, source/seed hashes, exact predecessor SQL, import SQL and target/
configuration templates. The proposed new database names are
`tibotattle-rehearsal-import58-primary-20260909-a6e8e3ce` and
`tibotattle-rehearsal-import58-ledger-20260909-a6e8e3ce`.
UUID placeholders intentionally refuse execution until exact new creation
receipts are bound. The complete import-file SHA-256 is
`e0795f0a1823d79d89522ba317f7462079c70c06e43c96a12568476c91f126d4`.

The requested approval covers creating those two resources, the small exact
migration rehearsal/readbacks and deleting only the newly created UUIDs after
known terminal results and ownership verification. Production, existing staging,
real records, deployment, collection activation and multi-gigabyte fixtures are
excluded. Unknown creation/import/deletion stops for reconciliation. No new
remote resource or exact-migration hosted run has been performed.

# Live configuration and recovery preparation

At `2026-09-09T18:19:57Z`, the active deployment was
`949daaea-948c-4da4-9f35-5b3493d1348e`, created September 8 at 14:39:51 UTC,
with version `8258bfd0-5c19-4127-a23c-0f325f18044e` receiving 100% of traffic.
Both accountless mode variables are absent; `ENROLLMENT_MODE` is `open`,
`ACCOUNT_SCOPED_INGEST_MODE` is `disabled`, and the identity-link version is
`production-v1`. Required secret-name checks passed for both envelope keys,
`IDENTITY_LINK_SECRET`, `APPLE_PRIVATE_KEY`, and `GOOGLE_OIDC_CLIENT_SECRET`.
Presence is not a claim that key contents were read or independently validated.
Collection revision 1 is `operational`, reason `initial`, with enrollment,
upload registration, processing and publication all enabled. The closed
`required-secret-presence.json`, `deployment-config-metadata.json`, and
`collection-control-metadata.json` receipts retain those observations privately.

Both D1 bindings returned current recovery bookmarks at 18:21 UTC, retained in
`recovery-bookmarks.json`. These establish bookmark availability only. They are
not the eventual migration restore targets because collection was still open.
No database export, restore or remote syntax rehearsal was performed.

The exact migration operation should include these recovery controls:

1. Recheck the source SQL hashes and both prefixes. Through the maintained
   revision-checked production control operation, pause collection for the
   bounded migration window and verify the resulting revision and all four
   disabled flags. This short interruption is part of the operation requiring
   approval; do not use the local-only collection-control script remotely.
2. After that readback, retrieve fresh Time Travel bookmarks for both databases
   and retain the timestamps privately. The primary restore point must itself
   contain the paused controls, avoiding an accidental reopening after restore.
   Confirm the actual recovery window with the provider; do not infer its length
   from the current bookmark. Cloudflare documents an always-on recovery history
   whose window depends on plan, and an in-place destructive restore. See
   [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
3. Apply only primary 0057–0059 using the canonical migration tool, then observe
   both ledgers again. Preserve the exact migration outcome, schema/FK/integrity
   checks and bounded preservation summaries. A timeout is an uncertain result:
   inspect the ledger and stop before a blind retry or deployment. No deletion-
   ledger migration, key rotation or R2 rewrite belongs to this operation.
4. Prefer forward repair if admission fails. Never delete ledger entries or
   reverse 0058 by hand. A separately approved emergency primary restore must
   use the captured paused bookmark and retain the newest independent deletion
   ledger; rewinding that ledger could resurrect erased sources. Preserve the
   pre-restore/undo bookmark too. Reconcile the restored schema with compatible
   code and reapply the reviewed forward migrations before reopening service.
5. Keep collection paused until required lifecycle work has replayed the latest
   tombstones and identity cooldowns, reconciled quarantine, and reported
   `restoreReplayComplete` with no unfinished owner/restore fence. Preserve R2
   deletion results; never recreate missing objects or clear tombstones to make
   recovery pass. Resume the previously recorded collection settings through a
   separate revision-checked readback. A bookmark does not qualify this recovery
   procedure as executed; no production restore has been rehearsed.

# Bounded production canary and cleanup

The canary is one synthetic source in a newly provisioned GitHub-hosted Mac
account, using an explicitly selected ordinary signed Electron artifact and
verified source/ASAR digests. It must refuse any existing normal profile,
legacy TiboTattle state or Codex directory before creating the tiny fixture.
Do not repoint the staging marker or introduce production credentials into CI.
The same existing native introduction, Settings bridge and owned-process
controls can establish acceptance, retained binding after restart and durable
opt-out. Limit the fixture to two content-free usage/quota events; do not query
or copy user history. An unchanged-input restart proves retained installation binding and an
authenticated ownership request before the zero-work incremental check. It does
not prove duplicate-record counts on the server; that requires a separate
bounded owner readback. Neither observation proves every possible duplicate
upload attack is prevented.

Settings off stops future delivery; accountless production deliberately does
not expose the older loopback disconnect route. The maintained cleanup is the
Access-owner `run_maintenance` action with an exact `participantErasure` target,
which revokes accountless authority and runs the deletion-safe pipeline. The
accountless ownership response reveals only the synthetic device ID, so resolve
its one participant through a private exact-device lookup before erasure.
Never infer the target from a timestamp, recent row or aggregate count.

A one-run owner public key may encrypt that synthetic device ID for the local
owner; its private key stays local. CI artifacts must contain neither raw
identifiers nor credentials. A runner result remains `cleanup_required` until
the owner decrypts the handoff, verifies the app/source binding, resolves only
that exact owner, and completes the maintained Access-owner, origin/header-protected erasure.
Retain only the operation reference, participant digest and closed result. An
ordinary maintenance response, opt-out, expired CI machine or timeout is not
erasure. Failed cleanup remains a visible retained synthetic contribution,
with the paused local source and owner retry procedure preserved.

Before requesting the canary's final approval, bind the reviewed wrapper,
artifact digests, one-run cleanup public-key digest, fixture limit and this
single-source owner-erasure scope. No current script execution is authorized
by this proposal alone. The production accountless flags must be deployed and
verified first; all accountless public selectors remain excluded. Public sample
admission is a separate product and aggregation decision below.

# Prepared executable canary

The separate [canary workflow](../../.github/workflows/electron-production-canary.yml)
uses a fresh `macos-26` account, pinned Node 26.2.0, read-only repository access
and no production secrets. Push only registers the workflow; the canary job is
manual-dispatch-only and defaults to `plan`. The reviewed runner commit must
match `GITHUB_SHA`. No staging workflow or staging endpoint is repointed.

Its artifact allowlist is exactly:

- [Normal .18 arm64 ZIP](https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64/TiboTattle-0.1.19-native-to-electron-handover.18-mac-arm64.zip), 119,158,056 bytes;
  SHA-256 `98d32e2a25b4d860d1a60cbdc94fc2a2dbb2dc3e0af58510a0e85e6d1fa24936`.
- Signed application source `7293828ade187f6fd9e50c67d7018704150ca156`;
  ASAR SHA-256 `e7c725a0902a18a0970265a8b32535fbe8e447829754592af91fc709eb0a987e`.
- Version `0.1.19-native-to-electron-handover.18`, build `2026090920`.
  This is the normal production contribution runtime with the deliberately
  separate Mac handover test update channel, not a stable public release.

The [runner](../../scripts/run-signed-electron-production-canary.mjs) successfully
completed local `--plan` against those installed bytes after exact digest,
source, ordinary manifest and production Developer ID signature verification.
The private `production-canary-plan-qualified.json` receipt records preparation
only. No application launch, real profile read or production request occurred.
A one-run RSA-4096 cleanup key pair was generated locally with owner-only
permissions. Its public PEM digest is
`05130deadb623f30fe4986e30303d506fc9531737fb75ebd4f83a9853a3123f8`;
its private key remains local and is never a workflow input.

After review/commit, dispatch `electron-production-canary.yml` with `mode=plan`,
that exact 40-character runner commit, the artifact identities above, the
base64-encoded **public** PEM and its digest, with empty `confirmation`. This
qualifies hosted intake only. Once the schema/configuration operations and
single-source production canary are explicitly approved, the same inputs use
`mode=execute` and `confirmation=RUN_ONE_SYNTHETIC_PRODUCTION_CANARY`. The runner
requires the actual disposable OS account, untouched normal/legacy/Codex paths,
and real native Continue interaction. It writes only the tiny synthetic fixture;
no default-on preference or acknowledgement is injected.

A completed client journey exits with `cleanup_required`, not a release pass.
Only closed receipts and an AES-GCM encrypted target with an RSA-OAEP wrapped
key are uploaded. The owner privately decrypts the exact operation/source/ASAR-
bound device target, resolves its participant, performs the maintained targeted
erasure and verifies completion. Any timeout, missing target, unfinished fence
or partial enrollment stays unresolved. The controlled process restart is not a
native menu-quit qualification. The hosted **plan-only** run
[34391083322](https://github.com/adamallcock/tibotattle/actions/runs/34391083322)
at runner `a76c11ff` passed exact archive/signature/source/ASAR verification and
reported the actual .18 handover channel. Its receipt says `prepared`, with
launch/upload/restart/opt-out evidence false. Production acceptance,
duplicate-count readback, public exclusion and owner erasure remain unexecuted.

# Proposed operation sequence

1. **Read-only intake.** Observe both production D1 migration ledgers with the maintained [migration rehearsal command](../runbooks/release-migration-rehearsal.md#observe-the-deployed-prefix). Record the exact Worker revision and collection-control revision/values. Inspect required secret names and bindings without reading or rotating their values. Preserve existing production encryption keys and the identity-link key/version.
2. **Prepare exact migration admission and recovery.** Canonical accountless source migrations are `0057_accountless_enrollment_ledger.sql`, `0058_accountless_upload_ownership.sql`, and `0059_accountless_upload_renewal.sql`. These are the exact pending names at the observation above; the corresponding populated local rehearsal passed. Recheck the remote prefix and intended source before admission. Migration 0058 snapshots/rebuilds populated ownership tables and restores their descendants; prepare the production backup/recovery and deletion-ledger implications before requesting approval for the exact pending set. Retained synthetic preservation tests do not measure current production size or attest remote migration bytes.
3. **Apply only the approved migration operation.** Use the maintained [production migration gate](../runbooks/production-operations.md#schema-migration-gate). Retain exact migration/ledger readback, foreign-key/integrity and preservation evidence. The deployment wrapper does not apply migrations. Do not deploy code requiring new columns before their schema is verified.
4. **Deploy the reviewed accountless configuration and privacy copy.** After schema verification, use the immutable production deployment wrapper, with normal preflight and post-deploy checks. The proposed configuration diff below enables the two accountless authority routes. Confirm `enrollment`, `uploadRegistration`, and `processing` collection controls permit the intended operation; do not change unrelated controls or disable existing social publication. Preserve social enrollment and all existing abuse limits, bindings and secrets.
5. **Verify a bounded, explicitly approved production canary.** Use an ordinary signed candidate and a disposable synthetic source. Verify enrollment, accepted encrypted upload, authenticated restart continuity and persistent opt-out; retain separate owner readback for duplicate-count and public-exclusion checks. Confirm the source remains excluded from public aggregates and revoke its authority afterward. The staging rehearsal is compiled to staging: do not repoint it or remove its isolation checks. The exact prepared runner and fixed-artifact dispatch below require this separate live-write approval; owner cleanup remains an explicit follow-on, and no production canary has run.
6. **Publish the release only after its independent gates pass.** Bind the deployed service, privacy wording and expected contribution behavior to the exact release artifacts. The genuine Mac .17→.18 automatic update and normal .18 refresh now pass in the readiness record. Windows signed runtime and protected R7 remain separately tracked; this plan does not close them.

# Proposed configuration diff — not applied

Only add these two properties to `env.production.vars` in `apps/worker/wrangler.jsonc`, after the existing `ENROLLMENT_MODE` property:

```diff
         "ENROLLMENT_MODE": "open",
+        "ACCOUNTLESS_ENROLLMENT_MODE": "enabled",
+        "ACCOUNTLESS_OWNERSHIP_MODE": "enabled",
         "ACCOUNT_SCOPED_INGEST_MODE": "disabled",
```

Both modes are explicit deployment controls; an app preference alone cannot open the server. No new production secret, key rotation, public-selector change or persistent unrelated mode change is proposed. The migration operation separately includes a temporary revision-checked pause and restoration of all four collection controls, as specified above.

For an admission incident, disable the two accountless modes and verify refusal of enrollment/ownership/renewal. That is **not** a claim that already issued upload authority is revoked: use the reviewed targeted revocation or collection-control response for accepted/in-flight authority. Do not roll back the rebuilt schema or deploy incompatible old code as an automatic recovery step. Preserve receipts and reconcile ambiguous remote outcomes before retrying.

# Separate public-sample decision

Recommendation: activate accountless collection with the current public exclusion retained, and describe that exclusion accurately. Public inclusion is not a deployment toggle today. It needs an explicit decision and engineering to adapt the social-only selectors and publication rules.

The proposed label is **contribution sources**, not people or verified provider accounts. One retained installation deduplicates retries; independently created installations can upload overlapping cloud-synced history. A global overlapping-history policy is not implemented. Before public admission, decide how to handle that overlap and source influence, preserve conflicting/partial evidence and existing suppression/revocation, and test the resulting aggregation. Do not silently clip accepted usage totals or merge distinct provider accounts.

# Completion evidence

Retain the exact source/configuration and migration digests, authorized operation identifiers, readbacks, privacy deployment verification and canary receipt. Keep schema, deployment, accepted private collection, public aggregate admission, signing, installed runtime, updater and release publication as separate claims. Only read-only health, migration-ledger, deployment/configuration, secret-name, collection-control and recovery-bookmark observations were performed against production while preparing this proposal; no production state was changed.
