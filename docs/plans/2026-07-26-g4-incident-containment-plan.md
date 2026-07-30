---
title: G4 Incident Containment Control Plan
date: 2026-07-26
type: plan
status: verified-development
---

# Outcome

Add independently controllable, fail-closed collection switches to the
development Worker and prove that they can contain an incident without a code
deployment, without exposing participant data, and without disabling
participant access, export, revocation, or deletion rights.

This is a development incident drill. It does not authorize production
deployment or external participant collection.

# Control contract

One strict singleton D1 row controls:

- enrollment;
- session and device upload-registration;
- encrypted contribution processing; and
- scheduled/public aggregate publication.

The row contains only a schema version, four booleans, a fixed lifecycle state,
a monotonically increasing revision, a fixed reason code, and timestamps. It
contains no operator identity, note, participant identifier, object reference,
request value, or arbitrary text.

Missing, malformed, or unreadable state fails closed for every controlled
operation. Participant recovery, logout, security reset, device listing and
revocation, personal results, export, contribution deletion, and full
participant deletion remain available during containment.

# Operator boundary

There is no administrator HTTP endpoint. A local-only operator command changes
the isolated D1 singleton through Wrangler:

- inspect;
- contain all;
- independently pause one controlled subsystem;
- independently resume one controlled subsystem with an exact confirmation;
  and
- restore all with an exact confirmation.

The command accepts only a fixed action vocabulary and emits only the strict
content-free control projection. Remote operation remains unsupported until
production operator authentication, approval, audit, and rollback boundaries
are separately reviewed.

# Runtime behavior

- Enrollment checks both configured admission mode and the D1 enrollment
  switch before reading a request body or consuming an invitation.
- Upload-registration checks its switch before authenticating a session/device
  or reading a registration body.
- Contribution processing checks its switch before reading ciphertext or
  claiming a one-use upload authorization.
- Publication checks its switch before serving an aggregate and before a
  scheduled build.
- Health reports the four non-sensitive switch states and effective enrollment
  availability.
- The local dashboard shows a bounded contained/degraded/operational state
  without exposing revisions, reasons, identities, or internal storage.

# Incident drill

Against a fresh loopback Worker, D1, and R2:

1. enroll and accept one encrypted privacy-safe contribution;
2. change all four controls without restarting the Worker;
3. prove enrollment, upload-registration, processing, and publication stop;
4. prove personal stats, export, device revocation, contribution deletion, and
   participant deletion remain available;
5. prove processing pause does not consume a pending one-use authorization;
6. restore controls using the exact confirmation;
7. prove normal enrollment and encrypted processing resume;
8. delete every participant; and
9. verify zero participant/session/device/upload/contribution/record/R2 state.

# Release boundary

The drill cannot close G4 because the backup incident owner, production contact,
cloud project/region, processor inventory, approved retention schedule,
production log inspection, KMS rotation, backup/restore suppression, external
review, and named-human reopening approval remain missing.

# Verified checkpoint

The source, focused tests, local operator check, live HTTP drill, participant
rights, resumed one-use authorization, and post-delete D1/R2 zeros are recorded
in the
[development verification receipt](../receipts/2026-07-26-g4-incident-containment-verification-receipt.md).
