---
title: Accountless sharing defaults and existing-install transition
date: 2026-09-04
type: decision-record
status: accepted
---

# Accountless sharing defaults and existing-install transition

The product owner approved automatic sharing for fresh Electron installations
on 2026-09-04, with a persistent opt-out and no sign-in. Existing installations
that have never made a sharing choice receive three notices and then switch to
automatic sharing unless they choose otherwise. This replaces the proposed
default-off design for the new Electron mode. It does not assert that a release
or hosted deployment has adopted this behavior.

## Choice and timing

- A positively identified fresh installation starts with sharing enabled under
  the versioned policy. Local analysis remains usable offline and without an
  account. A sharing failure cannot block the local dashboard.
- A known existing installation with no previous choice starts in a pending
  transition. No accountless contribution is sent during that transition.
- Each notice explains the fields shared, that sharing will become automatic,
  the remaining notices/time, and how to keep it off. Both **Share now** and
  **Keep sharing off** are immediate choices and cancel every remaining notice.
- A notice counts only after it is actually displayed in a visible app surface.
  Background launch, receipt creation, hidden renderer execution, an OS
  notification request, or a timer alone do not count as delivery.
- Candidate timing is seven days: notices are eligible from days 0, 3 and 6,
  additionally separated by at least 24 hours. Automatic activation requires all
  three display receipts, at least seven days since the transition started,
  and at least 24 hours after the third display. Infrequent use extends the
  transition. This cadence is an implementation assumption offered to the owner;
  the durable contract carries the schedule rather than guessing from launches.
- Explicit opt-out, pause or device disconnect survives upgrade and restart.
  Unknown/corrupt state and uncertain installation provenance remain off.
  Missing settings alone never establish a fresh installation.

## Durable authorization

Store the policy version, destination, selection basis and notice progress in
protected local state. Distinguish fresh default-on, transition default-on and
an affirmative user choice. Automatic activation is not an explicit-consent
event; never invent a consent timestamp, web session or pairing to satisfy a
legacy schema.

Persist an opt-out before reporting success. Cancel in-flight enrollment/upload
work, stop future scheduling, and preserve the off preference if remote
revocation fails. Unknown or failed local persistence blocks sending. An app
restart, missing credential, expired receipt or policy upgrade cannot reset an
explicit opt-out. A later affirmative user action may re-enable sharing.

The owner clarified on 2026-09-15 that opt-out and ordinary device disconnect
stop future uploads only. Already accepted records remain eligible for analysis;
these actions must not delete history, withdraw published graphs, invalidate
completed calculations, or restart historical work. Credential revocation still
blocks new admission. This supersedes the earlier coupling of user-requested
revocation to public-source withdrawal. The
[upload-only opt-out decision](./2026-09-15-opt-out-stops-future-uploads.md) records
the implementation and deployment boundary.

Policy or destination changes require a reviewed migration contract; do not
silently reuse a choice for another destination. Preserve existing identity,
account-track and accepted-history continuity where it can be verified.

## Installation continuity and lease renewal

The 2026-09-07 implementation separates durable installation ownership from the
30-day upload lease. Expiry stops uploads; it does not prove that a different
installation now owns the local data. The explicit authenticated renewal route
requires the same secret, active installation/owner/device/authorization graph,
and unchanged policy. It renews within the final seven days or after an offline
period, keeping the same identities and accepted upload history. Ordinary
enrollment replay does not renew. Lost responses converge on the existing
renewed lease, without consuming another installation slot. The optional v1.2
successor grant belongs to the same lease: renewal extends it with the rest of
the graph (ingestion-isolation migration `0010`, 2026-09-25), and a grant that
a renewal left behind is reported as not current and caught up by the next
successor authorization request instead of silently blocking v1.2 uploads.
Renewal never creates an absent v1.2 grant or reactivates a revoked or
mismatched one.

Revocation, erasure, containment, conflicting identities and policy mismatches
remain terminal. Renewal never clears a local opt-out, recreates an erased
owner, invents consent, or grants public-aggregate eligibility. This implements
the automatic-sharing lifecycle; it does not activate a hosted environment.

## Data and release boundary

Sharing remains allowlisted and content-free. Prompts, responses, credentials,
private paths, raw account identifiers and arbitrary upstream fields remain
excluded. Installation credentials authenticate an uploader; they do not prove
a unique person or a provider account. Quota/usage linkage, replay, deduplication,
abuse budgets and aggregate eligibility keep their independent contracts.

Legacy native/social enrollment remains compatible during the transition. The
new installation mode must not route the person through sign-in. The initial
enrollment-only ledger is not upload authority; authenticated upload ownership,
revocation and renewal require an additive implementation before collection can
be activated in a distributed build.

The [desktop convergence plan](../plans/2026-09-04-desktop-convergence.md) owns
implementation and evidence. Publication, production settings, remote database
migrations, signing and installed replacement remain separate operations.
Update first-run copy, Settings and public privacy disclosures before activation.

## Google Cloud cutover amendment (2026-10-02)

Owner decisions of 2026-10-02 amend the transition for the switch of the hosted
service to Google Cloud. Nothing here has happened yet; it takes effect at the
switch.

- **Round 12: native social enrollment retires at the switch.** Google and
  Apple sign-in and the legacy `/api/v1/enroll` route are not ported. Credential
  renewal and disconnect stay, so already-paired native social devices keep
  uploading until their 180-day credential sunsets and then move to the
  accountless desktop path. The session, logout, pairing, device and v1.2
  consent routes stay ported. The retirement is disclosed at the cutover.
- **Round 16: the identity-link secret is rotated.** The production
  `IDENTITY_LINK_SECRET` that keys sign-in link keys is lost, so the cutover
  installs a newly generated secret under a new key-version label, through a
  recorded and separately authorized step
  ([cutover window](../runbooks/gcp-cutover-window.md#identity-link-rotation-round-16)).
  This is admissible only because round 12 retires every route that consumes
  the identity-link pin, a provider subject's link key or a re-enrolment
  cooldown digest. The origin still keys its rate-limit subjects (client
  address and upload principal) with the secret; those keys last one
  60-second window and carry no continuity. Consequences: prior Google and
  Apple sign-in links cannot be re-established, and any future social sign-in
  starts a new identity namespace rather than reattaching an existing
  participant. The imported link keys remain stored, content-free and unused.
  Uploads, the content-free sharing contract, pseudonymity and the 180-day
  sunsets are unchanged, so no public disclosure beyond round 12's retirement
  is needed.
- This record does not claim that the old link keys are unlinkable to provider
  accounts until the Cloudflare Worker's copy of the old secret is deleted
  after the switch.
