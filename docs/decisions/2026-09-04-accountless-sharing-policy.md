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

Policy or destination changes require a reviewed migration contract; do not
silently reuse a choice for another destination. Preserve existing identity,
account-track and accepted-history continuity where it can be verified.

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
