---
title: Account-Scoped Local Ingest Activation Plan
date: 2026-07-26
type: plan
status: verified-local-checkpoint
---

# Account-scoped local ingest activation

## Outcome

Make the existing `telemetry-contribution-v0.2` account-scoped implementation
testable through the real encrypted HTTP boundary on loopback, while preserving
the prohibition on public or external-participant collection.

The completed local slice must prove:

1. explicit renewed v0.2 consent at enrollment;
2. encrypted upload authorization and bounded request handling;
3. closed-schema validation and privacy-canary rejection;
4. R2 quarantine plus canonical D1 ingestion;
5. server-side repricing, deduplication, and occurrence-conflict rejection;
6. participant-isolated account tracks and complete-dataset semantics;
7. private five-hour/seven-day calibration in participant stats;
8. contribution export and contribution/participant deletion;
9. no account-track identifiers in community output;
10. fail-closed behavior anywhere except an explicitly configured loopback
    development server.

## Safety boundary

This work does **not** authorize production deployment or external
participants. The external contract remains disabled until all existing
activation gates have dated evidence:

- three completed prospective provider/account/plan-scoped reset observations;
- accepted preregistered minimization receipt;
- renewed consent suitable for external presentation;
- security and privacy review;
- complete HTTP deletion and rendered-UI verification.

The local activation therefore requires all of the following:

- `ENVIRONMENT` is an explicitly recognized local-development value;
- `ACCOUNT_SCOPED_INGEST_MODE=local_preview`;
- the request URL host is `localhost`, `127.0.0.1`, or `[::1]`;
- enrollment uses `privacy-safe-telemetry-v0.2`;
- the plaintext uses the closed v0.2 contract.

Any missing or contradictory condition fails closed.

## Implementation sequence

### A. Contract and configuration

- Add a single local-preview mode parser with tests for invalid combinations.
- Keep the default and checked-in deployment posture disabled.
- Advertise local-preview state accurately in `/api/health`.

### B. Consent and transport

- Permit non-synthetic v0.2 enrollment only in the local-preview context.
- Reuse the existing encrypted envelope and one-use upload authorization.
- Dispatch decrypted plaintext by schema version only after consent and local
  activation checks.

### C. Canonical ingestion

- Promote the shadow repository function to a production-quality internal
  repository entrypoint while retaining a compatibility alias if useful.
- Preserve server repricing and participant-scoped dataset/account metadata.
- Store the encrypted envelope in quarantine and delete it on failed commit.
- Preserve envelope and plaintext replay behavior.

### D. Participant results

- Return account-scoped calibration only to the authenticated participant.
- Make incomplete/insufficient datasets explicit rather than presenting a
  false allowance estimate.
- Keep community aggregation schema free of account-track fields.

### E. Verification

- Add HTTP tests for consent mismatch, disabled mode, non-loopback rejection,
  valid local upload, replay, occurrence conflicts, cross-participant
  isolation, partial dataset behavior, export, and deletion.
- Run a real loopback Worker smoke using encrypted v0.2 contributions and
  inspect D1/R2 state.
- Render the participant UI and verify the account-scoped explanation and
  results.
- Run Worker checks, root product checks, and root tests.

## Release decision

The local slice is verified. The encrypted loopback smoke, isolated D1/R2
inspection, participant export/deletion, private UI rendering, and focused
adversarial tests passed on July 26, 2026. Checked-in configuration remains
disabled and the contract continues to report
`externalParticipantsAuthorized: false`. A later dated decision receipt is
required to cross that boundary.
