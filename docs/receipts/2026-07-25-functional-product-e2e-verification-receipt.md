---
title: Functional Product End-to-End Verification Receipt
date: 2026-07-25
type: verification-receipt
status: passed-local-development
---

# Functional Product End-to-End Verification Receipt

## Scope

This receipt covers the local-development product path only:

1. generate a fresh, privacy-verified local bundle from real retained Codex
   evidence;
2. convert it into bounded, content-free transport batches;
3. run the Cloudflare Worker against local D1 and R2 emulation;
4. run the loopback companion with its fixed same-origin central relay;
5. upload through the consumer dashboard;
6. observe personal and privacy-thresholded community results;
7. replay a batch;
8. reject a deliberately contaminated encrypted payload; and
9. delete the participant and verify removal from both stores.

It does not authorize public deployment, volunteer collection, background
upload, or production claims.

## Environment

- Verified at `2026-07-26T03:02:51Z` (`2026-07-25` America/New_York).
- Source checkpoint before this uncommitted wave: `eef120b`.
- Node.js `v26.2.0`.
- npm `11.13.0`.
- Central service: Wrangler local D1/R2 emulation on loopback.
- Consumer surface: Codex in-app Browser against the loopback companion.

## Real safe-export evidence

A fresh 7.5-minute local interval produced:

- 158 usage events;
- 164 quota snapshots;
- 13 source files;
- a 400,284-byte verified local bundle; and
- two transport batches containing 200 and 122 records respectively.

The transport batches were 213,074 and 129,043 bytes. The converter
re-verified the bundle and privacy receipt, removed participant, account, and
session scope identifiers, and wrote owner-only no-clobber files. Raw logs were
not sent to the browser or central service.

## Browser and central lifecycle

The dashboard rendered real retained evidence rather than demo data, including
two seven-day account windows, a `$511.64` seven-day API-price equivalent,
823 matched three-hour gradient windows, and 14 weekly calibration rows. The
evidence was correctly labelled stale rather than live.

The browser then:

- encrypted and submitted the first real batch;
- displayed 99 personal usage events and approximately `$9` API equivalent;
- encrypted and submitted the second batch;
- updated the personal result to 158 usage events and approximately `$15`;
- kept community results suppressed at one eligible participant;
- replayed the second batch with the same contribution identifier and unchanged
  personal totals;
- exposed a content-free participant export and complete-delete controls; and
- deleted both contribution batches and the anonymous participant capability.

The narrow-layout check originally found horizontal page overflow caused by a
long privacy-state value. The definition grid now permits shrinking and wraps
long values. A repeat check measured equal document and viewport widths with no
page-level horizontal overflow. The final browser console contained no warnings
or errors.

## Backend and adversarial evidence

A separate direct backend participant exercised enrollment, encryption,
ingestion, replay, personal statistics, participant export, aggregate
suppression, full deletion, and old-token rejection:

- enrollment returned `201`;
- initial ingestion returned `202 accepted`;
- exact replay returned `202` with `Idempotency-Replayed: true`;
- personal totals contained 59 usage events and 63 quota snapshots;
- export returned `participant-export-v0.2` with one contribution;
- community output remained suppressed with two eligible participants;
- deletion returned `200` and removed one contribution; and
- the deleted access capability subsequently returned `401`.

A separately encrypted payload with a nested `prompt` field bypassed the
browser validator deliberately and reached the server validator. It returned
`400 PRIVACY_CANARY_DETECTED`, created no contribution, and the empty test
participant was deleted.

After the browser participant deletion, local D1 contained zero participants,
zero telemetry contributions, zero telemetry records, and zero
contribution-occurrence mappings. The local R2 emulator contained zero opaque
objects.

## Automated checks

`npm run product:check` passed:

- 17 consumer UI and browser-contract tests;
- 10 loopback companion and transport-builder tests;
- generated Worker type verification;
- TypeScript checking;
- 10 Cloudflare-runtime Worker tests; and
- a Wrangler deployment dry run.

That is 37 focused passing tests across the functional product slice. The
source-bound R7 release receipts remain deliberately stale after current source
changes and still require their separate exact-runtime regeneration workflow.

## Residual risks and non-claims

- API-price totals are client-declared and not yet independently repriced by
  the server.
- Production admission control, rate limiting, key rotation, queueing,
  backups/restores, incident drills, and deployment configuration remain open.
- Community output was tested for threshold suppression and by unit fixtures at
  three participants; no public aggregate has been authorized.
- Browser recovery-code display and server recovery are implemented, but a
  complete lost-browser recovery interface remains future product work.
- Contribution files are selected manually. Background or ongoing upload is
  intentionally disabled.
- This proves a functional local development system, not readiness for outside
  users.
