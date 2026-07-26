---
title: Inspectable Backend Laboratory Plan
date: 2026-07-26
type: plan
status: completed
---

# Inspectable backend laboratory

## Outcome

Provide one bounded local command that starts the production-shaped central
service, seeds it through the real encrypted HTTP protocol, and leaves a
privacy-safe cohort available for browser and database inspection.

This is a development laboratory. It must not authorize public collection,
external participants, or a production deployment.

## Required journey

1. Create a fresh owner-only state directory.
2. Apply the real primary and deletion-ledger D1 migrations.
3. Start the Cloudflare Worker on loopback with local D1 and R2 emulation.
4. Confirm that collection controls and required capabilities are available.
5. Enroll twenty isolated synthetic participants through HTTP.
6. Envelope-encrypt a content-free contribution and upload it with one-use
   authorities.
7. Prove exact replay deduplication, server repricing, participant isolation,
   contribution history, private statistics, and threshold suppression.
8. Trigger the scheduled aggregate build and prove that only the released,
   clipped, rounded community contract is public.
9. Write the primary participant recovery capability to a new mode-0600 file
   without printing the value.
10. Keep the Worker and its static portal running so a person can recover the
    seeded participant and inspect individual and community results.
11. Expose a separate database inspection command that reports bounded table
    counts without identifiers, secrets, or record contents, and count live
    local R2 objects through Wrangler's fixed local explorer route without
    returning object keys.
12. Preserve the existing destructive smoke to prove contribution deletion,
    participant deletion, aggregate withdrawal/rebuild, and final empty
    storage.

## Safety contract

- Bind only to `127.0.0.1` or `localhost`.
- Accept only generated content-free fixtures or already closed,
  owner-only contribution files.
- Never accept a raw Codex or Claude log file at the server boundary.
- Never print invitation, session, recovery, device, CSRF, upload, envelope
  private-key, participant, account-track, or occurrence identifiers.
- Create state and capability files without following symlinks and without
  overwriting an existing target.
- Keep personal reads authenticated and community reads privacy-thresholded.
- Treat browser inspection data as disposable development data.
- Make shutdown explicit. Do not silently delete an inspectable state tree.
- Make destructive cleanup operate only on the exact laboratory directory
  created by the command.

## Verification

The implementation is complete for this checkpoint when:

- the existing Worker unit/integration suite passes;
- the complete destructive HTTP smoke passes against fresh local state;
- the inspectable seed mode publishes a community snapshot and writes an
  owner-only recovery-capability file;
- database inspection agrees with the HTTP-level participant, contribution,
  record, snapshot, and quarantine expectations;
- a browser can load the Worker portal, recover the primary participant, and
  render private statistics plus the released community snapshot;
- a privacy-canary upload is rejected and creates no canonical contribution;
- stopping and restarting the Worker against the same state preserves the
  seeded results; and
- the documentation states exactly what is local proof versus an uncompleted
  staging or production gate.

## Non-goals for this checkpoint

- Public enrollment or external uploads.
- Cloud provisioning or enabling R2 billing.
- Production secrets, domains, monitoring, backups, or incident paging.
- A final packaged participant desktop installer.
