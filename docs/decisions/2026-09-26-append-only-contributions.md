---
title: Append-only contributions on the Google Cloud service
date: 2026-09-26
type: decision-record
status: accepted
---

# Append-only contributions on the Google Cloud service

> **Accepted.** The owner approved this text in chat on 2026-09-30. It restates
> choices the owner made in chat. This record changes no current Cloudflare behavior. It
> authorizes no production write, migration, deployment or cutover. It is not
> legal advice and makes no legal-sufficiency claim. It contains no
> identifiers, session content or deployment evidence.

| Field | Value |
|---|---|
| Decided by the owner | D1 to D4 and D6 in chat on 2026-09-26; D5 is the hosting boundary in force for the 2026-10-01 GCP fast path |
| Recorded | 2026-10-01, for the GCP fast path (DOC-1L) |
| Owner sign-off | Approved in chat on 2026-09-30 |
| Applies to | The proposed PostgreSQL service on Google Cloud, from an owner-authorized cutover |
| Does not apply to | Current Cloudflare production, local analysis, local erase or Keychain identity reset |
| Delivery plan | [GCP fast path](../plans/2026-10-01-gcp-fastpath.md) |

## Scope

- The current Cloudflare service keeps its shipped behavior until the reviewed
  writer fence and cutover. The accepted decisions listed under
  [Relationship to accepted decisions](#relationship-to-accepted-decisions)
  remain authoritative for it.
- D1 to D6 describe the Google Cloud target only. They take effect when the
  owner authorizes the cutover.
- Local analysis, local erase and Keychain identity reset are unchanged.

## D1. Upload revocation never withdraws accepted contributions

On the Google Cloud service, each of the following only revokes upload
permission:

- the app's local opt-out, which immediately stops that installation's
  scheduled uploads;
- an authenticated device disconnect or revocation received by the server;
- credential expiry, which pauses upload acceptance until the same
  installation renews;
- security reset;
- security containment;
- any other revocation, including partial authority changes, head removal and
  credential reuse.

Nothing else changes:

- Contributions already accepted stay in community analysis.
- No published statistic is retracted, hidden or withdrawn.
- No daily, graph or preview rebuild is triggered.
- No withdrawal, containment or erasure epoch exists.

The local opt-out is a local control. It stops that installation from
sending; it is not a server-side revoke request. A server-side revoke happens
only when the server receives the authenticated disconnect or revoke
operation. The Google Cloud routes and the client journey must prove these
boundaries. Do not promise remote revocation on a local settings toggle.

Collection controls remain the operator's brake on enrollment, upload
registration and processing. A controls change never forces a daily or graph
rebuild. The publication switch is a reversible serving switch: while it is
off, public reads are unavailable; nothing is deleted or withdrawn, and turning
it back on serves the same revisions.

Replay safety, deduplication, corrections, source attribution and statistical
suppression are unchanged. Keeping a source does not promise that its data
qualifies for any particular statistic.

**Open eligibility gap (OA-2).** Production's public-source eligibility view,
`community_public_source_owners`, drops accountless owners whose device or
grant was revoked for any reason other than a user opt-out, and drops
non-active participants. PostgreSQL migration `0046` on the GCP line ports that
view. It is narrower than D1. Until the owner resolves OA-2, the Google Cloud
service computes eligibility as production does at the seal, so recomputed
results stay comparable with production (fast-path default OD-3). Closing the
gap to D1 is a later change that must be disclosed. A missing withdrawn link
must not be fabricated to hide a divergence.

## D2. Erasure is a rare, manual, offline owner procedure (Variant B)

The running service performs no erasure. No route, admin action, scheduled
job, fence, erasure-ledger service, analytics owner retirement or rebuild
trigger performs erasure, and none is planned.

- [ ] **Variant A: no erasure.** Not selected.
- [x] **Variant B: a rare, manual, offline, owner-run procedure for a verified
  request.** Selected by the owner on 2026-09-26. Only the owner runs it. It
  adds no running code. It is not operational until OA-9 is resolved, the
  retained metadata is disclosed and this record is approved.

The Variant B steps:

1. Resolve the request through an owner-approved intake channel and proof
   method. The owner has not yet chosen the channel, the accountless identity
   lookup or the storage for the proof; OA-9 blocks operation until they are
   specified.
2. Commit the owner's upload revocation separately. Then, in one recoverable
   purge transaction:
   - lock the participant row `FOR UPDATE` to drain in-flight membership
     writes, and lock the shared `storage_source_state` singleton `FOR UPDATE`
     in the same order as journal append;
   - recheck the per-source cursor, dependent delivery work and v1.1
     projection work, and refuse without deleting anything if work is pending;
   - delete only reviewed raw input, object and derived rows, including the
     owner's owner-level analytics rows.

   This is not a global upload fence, although unrelated journal writes may
   wait briefly. Immutable journal rows, revision heads, applied-event markers,
   cursors and the erasure receipt may remain as pseudonymous owner-keyed
   metadata. This record does not claim they are erased, anonymous or
   unlinkable.
3. Add the purpose-separated deletion digest to a small do-not-restore list
   held outside the primary database and its backups. OA-9 must approve its
   custody and access.
4. Apply the list at import, and reapply it after any backup restore before
   uploads reopen. Before a rollback to frozen copies, apply the list there or
   destroy those copies.

The purge never retracts published aggregate statistics. A later ordinary
recompute no longer includes the purged owner, so recomputed values for
affected days can change; the disclosure must say so.

For the transfer from Cloudflare:

- Participants erased on Cloudflare before the seal stay excluded from active
  participant and raw-source import. The transfer proves, by count only, that
  no sealed active participant matches a sealed deletion digest.
- Deletion-ledger tables are not imported. Their content-free digest
  projection seeds the do-not-restore list.
- An imported erased owner cannot become an active source. Required replay
  metadata may remain. The transfer orchestrator, the offline procedure and the
  cutover disclosure must name the exact transferred and retained fields; do
  not promise that every owner-keyed row is absent.
- `DELETE /api/v1/me` stays retired (`404 NOT_FOUND`). Health keeps reporting
  `participantDeletion: false`.

## D3. Incremental analytics before the cutover cadence

The owner decided on 2026-09-26 that an incremental graph-day builder is a
cutover prerequisite, reversing the earlier plan to leave it unported. Because
the data is append-only, the GCP form needs no online erasure fences, no
withdrawal-driven publication retirement and no per-day completeness pages.

**Proposed restatement, confirmed by this sign-off.** On Google Cloud the
requirement is met by the analytics-refresh job's digest-keyed owner-day memo,
with a dirty-owner cursor over the ingestion journal and a nightly full
recompute. It is not met by a line-by-line port of the Cloudflare D1 builder
and its checkpoints. The memo must exist and be measured before the cutover
cadence is set. Analytics history is recomputed from transferred evidence, not
imported; the [fast-path plan](../plans/2026-10-01-gcp-fastpath.md) records
the consequences.

## D4. Database scaling is deferred

- The service runs on one Cloud SQL PostgreSQL 17 instance.
- The cutover adds no read replica, sharding or sizing program beyond
  provisioning that instance. Throughput is measured and scaled later if
  needed.
- There is no separate deletion-ledger instance. Until the SIMP-4 code removes
  it, the runtime's `ledger` role uses an interim second schema or database on
  the same instance.

## D5. Cloudflare remains the edge and the release host

- Hostnames are unchanged: `tibotattle.com`, `www.tibotattle.com` and
  `admin.tibotattle.com`. There is no DNS change. The switch is an
  owner-authorized Worker redeploy.
- A thin Cloudflare Worker proxies application routes to an IAM-private Cloud
  Run origin. It attaches a Google ID token for a dedicated edge-invoker
  service account. The origin accepts only the edge-to-origin transport
  contract (EP-0, enforced by the EP-6 origin boundary).
- Admin stays behind Cloudflare Access.
- Release, appcast and update hosting, and download analytics, stay on
  Cloudflare (the EP-3 split).
- The edge proxy itself (EP-4 and EP-5) is not built yet; it is on the
  cutover backlog.
- The post-flip rollback policy is a separate owner decision.

## D6. Simplify the GCP line

In GCP-line source that has not shipped to production, remove the machinery
that exists only for:

- withdrawal and containment withdrawal;
- online erasure and analytics owner retirement;
- erasure fences and containment epochs;
- erasure-driven rebuilds;
- the separate deletion ledger.

Keep only what is needed for:

1. stopping uploads;
2. replay safety, deduplication and corrections, including immutable journal
   and revision metadata;
3. importing and honoring Cloudflare's active-source exclusion, while
   accurately disclosing retained replay metadata;
4. the Variant B offline procedure, which adds no running code.

Ordering constraint: the SIMP-0 amendments and the SIMP-1 and SIMP-4 removals
land before any non-disposable database applies the staged primary migration
`0053` (analytics erasure fences) or the staged ledger migration `0007`. Both
are forward-only once applied.

## Superseded planning contracts

The following are GCP planning work items (plan-v4, 2026-09-27) and the
wave-1 branch code that implements them. None runs in production. On approval,
this record supersedes them for the GCP line:

1. **The 2026-09-27 SIMP-0 to SIMP-4 safety-reconciliation briefs**, wherever
   they keep erasure fences, the separate deletion ledger, tombstone and
   cooldown reads, restore replay, online owner-erasure modules or withdrawal
   reactions on Google Cloud. The 2026-09-26 SIMP-0, SIMP-1 and SIMP-4 briefs
   apply instead (fast-path default OD-2), with migration numbers assigned by
   the integration lead. SIMP-2 (journal terminal reactions) and SIMP-3
   (credential-free eligibility) wait for OA-2 and for the analytics-refresh
   job to replace the legacy GCP daily publisher; this record does not
   schedule them.
2. **PT-8's `CUTOVER_ERASURE_HISTORY_UNPROVEN` no-go.** It required PT-5b to
   import every deletion-ledger table into a separate ledger database, and
   every `0053` fence, receipt, watermark and publication-floor row to be
   imported or proven equivalent. It is replaced by:
   - seal the deletion-ledger D1;
   - derive its content-free deletion-digest projection as the do-not-restore
     list;
   - prove by count that no sealed active participant matches it;
   - import no ledger tables and no `0053` fence history.
3. **The separate deletion-ledger Cloud SQL instance in CR-3 and EP-7.** This
   covers CR-3's ledger pool, instance-independence checks and GCS
   erasure-history proof input, and EP-7's ledger variables on the production
   service template. It also covers PT-5b's ledger import and the "separate
   temporary deletion-ledger instance" wording drafted for the OPS-9 privacy
   change.

## Relationship to accepted decisions

Each decision below stays authoritative for the current Cloudflare service
until the cutover. If this record is approved, the following holds on the
Google Cloud service after the cutover:

- [Opt-out stops future uploads](./2026-09-15-opt-out-stops-future-uploads.md)
  is extended. It kept hard withdrawal for containment, reset, partial
  authority changes, head removal and owner erasure. On Google Cloud those
  also only stop uploads, and erasure follows D2.
- [Retire self-service hosted deletion](./2026-08-30-self-service-deletion-retirement.md)
  is superseded in part, for its erasure and restore sections. Owner erasure
  becomes the D2 offline procedure. Deletion-safe restore replay becomes
  reapplication of the do-not-restore list. The `404 NOT_FOUND` route,
  `participantDeletion: false`, **Disconnect this Mac** and the ban on raw
  identifiers in audit records are kept.
- [Published analytics remain visible during recalculation](./2026-09-16-published-analytics-continuity.md)
  is amended: no event withdraws or rebuilds a publication.
- [Shared public community sample](./2026-09-11-public-contribution-sources.md)
  is amended: its withdrawal and erasure terms follow D1 and D2.
- [Accountless sharing defaults](./2026-09-04-accountless-sharing-policy.md) is
  amended: revocation, credential expiry and containment stay terminal for
  upload permission but no longer withdraw accepted history. Persistent opt-out
  and the transition notices are unchanged.
- [Public community estimate gate](./2026-08-03-public-community-estimate-gate.md):
  the "deletion triggers withdrawal/rebuild" clause in item 4 does not apply on
  Google Cloud.

The supersession notes on those records are written in the cutover commit, not
before, so that each stays truthful for the running service.

## Guidance and disclosure consequences

- **Root `AGENTS.md`.** Checked at the GCP integration commit `cfd7dc39`. The
  product invariant "preserve durable opt-outs and legacy consent contracts;
  hosted erasure is owner-only" is compatible with D1 and D2: an opt-out stays
  durable and stops uploads, and Variant B is owner-only. No change is needed.
  Any later clarifying edit goes through the integration lead, adds no lines
  (the file is at 199 of its 200-line budget) and keeps
  `test/agent-guidance.test.js` green.
- **Scoped guidance and public disclosures.** `apps/worker/AGENTS.md` (owner
  erasure through the admin action, `deletionSafeRestoreReplay: true`),
  `docs/AGENTS.md` (deletion-safe restore), `SECURITY.md`, the privacy page,
  the local data and privacy reference, and the production operations runbook
  describe the running Cloudflare service. They change together in the
  approved cutover commit (OPS-9), not before.
- **Health on Google Cloud.** Omit `checks.deletionLedger` and
  `capabilities.deletionSafeRestoreReplay`, because there is no online ledger
  and no restore replay. Keep `participantDeletion: false` and
  `restoreReplayComplete: true`, because nothing is owed.
- **`SECURITY.md` scope on Google Cloud** adds:
  - an upload accepted after revocation;
  - a published statistic retracted or rebuilt because of a revocation;
  - a participant erased before the cutover reappearing;
  - raw identifiers in an erasure receipt;
  - a do-not-restore participant resurrected after a restore.
- **Privacy page at cutover.** It states that turning sharing off, disconnect,
  credential expiry and a security block only stop future uploads and never
  change published statistics. It describes the verified offline procedure,
  says published aggregates are not retracted and says the do-not-restore list
  is reapplied after any restore.

## Cloudflare until the cutover fence

- Current Cloudflare behavior is unchanged. Cloudflare may still withdraw or
  rebuild publication state on its shipped revocation, accountless
  credential-reuse and owner-erasure paths. Variant B does not disable
  Cloudflare erasure before the fence.
- Every in-flight Cloudflare erasure and analytics-delivery job finishes before
  the seal.
- This record makes no Cloudflare migration or production change. The
  ingestion-side D1 schema stays frozen until the seal (fast-path OD-9).
- D1 source selection at the seal is authoritative for which sources are
  active.

## Open owner choices this record does not settle

- OA-2: eligibility semantics for the recompute (see D1).
- OA-9: Variant B intake channel, proof method, accountless identity
  resolution and custody of the do-not-restore list.
- Whether recomputed past values that differ from published ones are accepted,
  or a frozen published snapshot is required for pre-seal dates, and whether
  published revision numbers must continue (fast-path OD-10).
- The rollback policy after the flip.
- Which legacy or optional routes may be deferred at cutover (fast-path OD-8,
  plus the admin, export, performance and Apple sign-in routes).

## Sign-off

- [x] The owner approved this text in chat (fast-path OD-6) on 2026-09-30.

Still owed: the supersession notes and disclosure changes above land in the
cutover commit.

## Evidence boundary

This record is an accepted decision text. It is not a deployment
receipt. Adoption, implementation, tests, privacy-page publication and the
production cutover are separate gates, and this document proves none of them.
