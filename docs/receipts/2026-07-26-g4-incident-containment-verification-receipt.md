---
title: G4 Incident Containment Development Verification Receipt
date: 2026-07-26
type: verification-receipt
status: passed-development
---

# Decision

The development incident-containment checkpoint passes.

This receipt does not authorize a production deployment, remote operator,
external participant, public route, or aggregate publication. G4 remains
blocked by the named production, human, cloud, retention, key-management,
backup/restore, notification, review, and remaining-drill requirements below.

# Implemented control

The Worker now has one strict D1 singleton containing only:

- a fixed schema version;
- independent booleans for enrollment, upload registration, processing, and
  publication;
- a fixed operational/degraded/contained state;
- a monotonic revision;
- a fixed reason code; and
- an update timestamp.

Missing or unreadable state fails controlled operations closed. There is no
administrator HTTP route. The local operator accepts only fixed actions, rejects
remote operation, requires exact confirmation for every resume/restore, and
returns a content-free projection.

Enrollment and upload-registration checks run before reading their request
bodies. Processing checks its switch before reading ciphertext or claiming a
one-use authorization. Publication checks its switch before serving public
results or building a scheduled snapshot.

Personal session/recovery operations, private stats, export, device
listing/revocation, contribution deletion, and full participant deletion do not
depend on the collection switches.

# Automated evidence

Focused Worker verification passed:

```text
npm --prefix apps/worker run typecheck
  passed

npm --prefix apps/worker test
  4 files passed
  55 tests passed

npm --prefix apps/worker run scripts:check
  collection controls local-only/independent/explicit-restore check passed
  enrollment grant operator check passed
```

The tests cover:

- all four controls and exact disabled error codes;
- session, device-pairing, device-claim, and device upload-registration scope;
- processing pause before one-use authorization consumption;
- explicit restoration and successful reuse of that pending authorization;
- public aliases and scheduled publication pause;
- missing control state failing collection closed;
- private stats/export/deletion during full containment; and
- zero retained R2 objects after participant deletion.

# Live isolated HTTP drill

A fresh loopback Worker, local D1, and local R2 were started from the current
source tree. A real 213,074-byte, owner-only
`telemetry-contribution-v0.1` fixture containing 99 usage events, 101 quota
snapshots, and no activity markers was validated locally and encrypted to the
Worker's live envelope key.

While the Worker remained running, a separate operator process changed the D1
control state. The next HTTP health request observed full containment without a
restart or redeployment.

The repeatable command reported:

```json
{
  "status": "passed",
  "target": "local",
  "noRedeployContainmentObserved": true,
  "enrollmentBlocked": true,
  "uploadRegistrationBlocked": true,
  "processingBlockedWithoutConsumingAuthority": true,
  "publicationBlocked": true,
  "privateStatsAvailableDuringContainment": true,
  "exportAvailableDuringContainment": true,
  "deletionAvailableDuringContainment": true,
  "explicitRestoreRequired": true,
  "ingestionResumedAfterRestore": true,
  "privateStatsUpdatedAfterRestore": true,
  "participantsDeleted": 2
}
```

After stopping the Worker, direct isolated-store inspection returned:

```json
{
  "d1": {
    "participants": 0,
    "contributions": 0,
    "records": 0,
    "uploadAuthorizations": 0,
    "deviceCredentials": 0,
    "deviceUploadAuthorizations": 0
  },
  "r2": {
    "objects": 0,
    "multipartUploads": 0,
    "multipartParts": 0
  }
}
```

The isolated local state was then moved to Trash. No production resource was
created or changed.

# Participant-visible behavior

The dashboard backend panel now distinguishes operational, partially paused,
and fully contained collection. It shows the effective state of enrollment,
upload registration, ingestion processing, and aggregate publication. It also
states whether private view/export/delete rights remain available.

The UI does not expose control revisions, incident reasons, operator identity,
participant identity, object references, or arbitrary diagnostic text.

# Remaining G4 blockers

- Backup incident owner and contact channel.
- Production project, region, processor, and jurisdiction decisions.
- Approved retention/lifecycle enforcement and deletion tombstones.
- Backup/restore suppression proving deleted data cannot return.
- Production KMS rotation and retired-key rejection.
- Production operator authentication, dual approval, audit, alerting, and
  rollback.
- Cloud log/trace/source-map field and retention inspection.
- Participant notice and incident-notification decision tree.
- Edge-fair rate limits, budgets, queue/cost alerts, and abuse/load drills.
- Canary, stolen-credential, cross-tenant, unauthorized-object, validator,
  KMS, restore, bad-release, and notification drills not already satisfied by
  focused development tests.
- Targeted external privacy/security review with no unresolved critical or high
  finding.
- Named-human approval to open G4.
