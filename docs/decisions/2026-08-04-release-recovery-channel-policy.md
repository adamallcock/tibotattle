---
title: TiboTattle Release-Recovery Channel Policy
date: 2026-08-04
type: decision-record
status: in-progress
---

# TiboTattle release-recovery channel policy

## Decision

Restore a trustworthy distribution path in stages. The first operational target
is a signed internal dogfood channel backed by a disabled staging service; it
is not a public beta and does not authorize public contribution collection.

The active integration checkout is not a release source. A release candidate is
created only from a clean, reviewed commit in the dedicated
`codex/release-recovery-internal` train, then bound to an annotated tag before
any signed artifact is built.

No automated task may deploy a Worker, change D1/DO/R2 state, change an
identity-provider portal, access a signing key, notarize, publish an appcast,
or replace an installed app. Those actions remain owner-run and require the
matching receipt described below.

## Channel contract

| Channel | Service target | Enrollment | Distribution | Required proof |
| --- | --- | --- | --- | --- |
| Development | Local-only fixtures or loopback companion | Disabled | Ad-hoc development app; no updater | Focused source and local-app tests |
| Internal dogfood | Separate staging Worker, D1, DO and R2 scope | Disabled by default; explicit test allow-list only if approved | Developer-ID signed/notarized app and separate beta Sparkle feed | Clean-profile install plus a real signed N to N+1 update rehearsal |
| Closed beta | Production-shaped service after staging proof | Explicitly authorised, initially invite-only | Signed/notarized app and reviewed beta/stable feed policy | Identity, deletion, ingress, observability and rollback receipts |
| Public release | Production | Explicitly authorised after beta | Signed/notarized installer and stable Sparkle feed | Public artifact, appcast, website, privacy and live-route receipts |

Development and dogfood builds must never present production claims merely
because a source field contains a production URL. An external build may carry
updater configuration, but that does not make its feed operational:
automatic-update opt-in and `reachable`/`ready` status remain unavailable until
the app independently observes a non-empty feed response. Update acceptance
also requires the referenced signed artifact to be read back for that exact
candidate and a real signed `N` to `N+1` rehearsal.

## Required receipt set

Each candidate has one content-free, versioned release receipt containing:

1. annotated tag, immutable commit SHA, dependency-lock digest, endpoint
   manifest digest, and channel;
2. staged migration identifiers and disabled-staging outcome, including a
   restoration/rollback result;
3. signed DMG filename, SHA-256, Developer ID identity, notarization/stapling
   and Gatekeeper result;
4. appcast URL, SHA-256, enclosure URL, length, Sparkle signature validation,
   public GET/HEAD cache results, and N to N+1 outcome;
5. Google/Apple browser-flow success, cancellation, expiry, duplicate callback
   and logout/disconnect results, with no provider token or account data; and
6. public root, community, privacy, support and download route checks.

Missing evidence is a failed gate, never an inferred success.

## Order of operations

1. Reconcile the actually deployed Worker and public routes with the intended
   disabled configuration. Contain an unintended open enrollment state before
   any testing that could accept external contributions.
2. Complete source integration in the release-control worktree, run the
   fail-closed local preflight, review the diff, and create an annotated
   internal-release tag.
3. Apply and exercise the identity/device/community migrations only in disabled
   staging. Prove D1, Durable Object, rate-limit, log-redaction, withdrawal,
   deletion and restoration behaviour there.
4. Verify provider-console callback registrations and run native system-browser
   journeys against staging. Source tests cannot substitute for these checks.
5. Build the tagged dogfood application, sign/notarize/staple it, and perform a
   clean-profile install and Login Item lifecycle rehearsal.
6. Publish only to the beta update feed, read back the immutable artifact and
   appcast, then demonstrate signed N to N+1 update, cancellation and fallback.
7. Build and verify the public-only website tree. It must never include the
   loopback dashboard or personal-data modules; it must show no installer until
   the signed artifact receipt exists.
8. Move to closed beta and then stable only through explicit owner approval.

## Delivery and rollback policy

Use full DMGs only until delta artifacts are generated, atomically published,
and rehearsed. Artifact objects are immutable and retained for the documented
support horizon. A bad update is corrected by a higher signed version or a
manual replacement path; the system must not attempt an unsafe downgrade.

The beta and stable appcasts are separate public endpoints. A stable appcast is
not created or updated as a side effect of internal testing.

## Consequences

- The current private backups preserve work, but they are not release receipts.
- A passing unit suite alone cannot authorize an external distribution claim.
- The release-control branch intentionally moves more slowly than feature work,
  while the bounded staging and dogfood lanes make real end-to-end testing
  possible before public enrollment.
