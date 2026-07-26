---
title: Participant Contribution History Plan
date: 2026-07-26
type: plan
status: verified-local
---

# Participant contribution history

## Outcome

Make accepted backend work visible to the authenticated participant. The
private portal should show a bounded list of contribution batches, their
covered period, accepted/deduplicated record counts, transport schema,
client-platform class, server-pricing status, and encrypted-quarantine
retention state. A participant must also be able to delete one contribution
without deleting the entire anonymous participant.

## Existing evidence and gap

The central Worker already stores participant-isolated contribution metadata
and exposes it from `GET /api/v1/me`, while complete safe data is available
from `GET /api/v1/me/export`. The portal currently fetches neither profile nor
contribution history. It therefore shows analysis totals without showing the
backend jobs that produced them, and its only visible deletion control removes
the complete participant.

## Contract

- Version the authenticated profile response as `participant-profile-v0.2`.
- Return at most the existing server ceiling of 101 contribution summaries.
- Keep the contribution identifier private and use it only for the participant
  row and exact contribution deletion request.
- Expose only closed enums, canonical timestamps, counts, schema/provenance
  fields, and server-repriced cost status already available to the participant.
- Do not expose envelope/plaintext digests, R2 keys, dataset/account
  pseudonyms, invitation eligibility, recovery/session/upload authority, IP
  data, source paths, prompts, responses, commands, or arbitrary diagnostics.
- Describe the seven-day encrypted-quarantine deadline independently from
  canonical metadata retention.
- Treat client software version as unavailable because the current transport
  does not carry a reviewed version field.
- Browser normalization projects unknown fields away and rejects malformed,
  oversized, or internally inconsistent history.
- Individual deletion remains CSRF-protected, participant-scoped, explicitly
  confirmed, and followed by a complete results refresh.

## Verification

- Runtime tests prove the correct participant can read their history and a
  different participant cannot read or delete it.
- Retention tests prove the history changes from encrypted object retained to
  encrypted object deleted while canonical metadata remains available.
- Browser tests prove arbitrary fields and malformed timestamps/counts fail
  closed.
- The real encrypted HTTP smoke reads the accepted history, deletes one
  contribution, and observes the updated list.
- Rendered browser QA verifies desktop and narrow layouts and the visible
  distinction between quarantine deletion and canonical metadata retention.

## Release boundary

This is a local production-shaped G8 slice. It does not authorize cloud
deployment, external participants, public aggregate release, or background
collection.

## Result

Implemented and verified locally on July 26, 2026. The authenticated portal now
loads `participant-profile-v0.2`, fails closed on an invalid history contract,
shows bounded canonical contribution summaries, and deletes one contribution
through the existing participant-scoped CSRF route.

The production-shaped HTTP smoke passed with twenty invite-only participants
and proved that accepted encrypted uploads appear in private history and are
removed immediately after contribution deletion. A separate browser-driven
local-open run used the portal's own file validation, client encryption,
one-use upload registration, Worker validation, D1/R2 ingest, history read, and
deletion controls. It also exposed and fixed a stale-history bug after complete
participant deletion: the UI was calling the nonexistent `renderStats`
function instead of `renderPersonalStats`.

The [verification
receipt](./2026-07-26-participant-contribution-history-verification-receipt.md)
records the commands, assertions, rendered evidence, cleanup, and remaining
release boundaries.
