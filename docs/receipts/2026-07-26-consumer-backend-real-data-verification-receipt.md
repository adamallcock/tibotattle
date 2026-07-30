---
title: Consumer Backend Real Data Verification Receipt
date: 2026-07-26
type: verification-receipt
status: development-verified
---

# Outcome

A privacy-safe contribution derived from real local Codex logs passed the
complete disposable central-backend lifecycle through the same Worker, D1, R2,
encryption, validation, pricing, personal-statistics, aggregation, export, and
deletion pathways used by the synthetic laboratory.

This is local-development evidence. It does not authorize external
participants, provision remote Cloudflare resources, or claim production
readiness.

# Real local preparation

The local exporter scanned a fixed one-hour interval,
`2026-07-27T01:00:00.000Z` through `2026-07-27T02:00:00.000Z`, across 19 local
source files. It created a mode-0600 local-review bundle containing:

| Record class | Count |
|---|---:|
| Usage events | 394 |
| Quota snapshots | 402 |
| Activity markers | 0 |
| Total safe records | 796 |

The canonical bundle was 984,415 bytes. Every privacy gate passed:

- schema allowlist;
- compatibility tuple;
- forbidden-key scan;
- sensitive-string scan;
- record-count consistency;
- provider-adapter compatibility; and
- source-value canaries.

The source bundle remained `transportReady=false`. The separate contribution
builder independently reverified it and produced four owner-only committed
transport batches. The batch exercised against the backend contained 99 usage
events and 101 quota snapshots, for 200 records and 213,315 bytes.

Raw rollout logs were never copied into the backend state. The temporary
review, prepared, invitation, and backend-state directories were moved to
Trash after verification.

# Backend lifecycle

The final proof used a fresh owner-only local persistence tree, all primary and
deletion-ledger migrations, twenty independent one-use invitations, and a
loopback Worker configured in invite-only mode.

The HTTP smoke passed:

- twenty isolated participant enrollments;
- one-use session and device upload authorities;
- browser-compatible RSA/AES envelope encryption;
- strict body, envelope, closed-schema, and privacy-canary validation;
- server-derived API-price-equivalent accounting;
- D1 contribution, record, occurrence, and participant isolation;
- exact participant-scoped replay deduplication;
- private server-repriced statistics and contribution history;
- delayed twenty-participant community publication;
- exact private clipped versus public rounded comparison;
- stable public snapshot bytes across both public aliases;
- bounded participant export;
- recovery rotation, security reset, device revocation, and logout;
- single-contribution deletion and immediate private-history removal;
- immutable aggregate withdrawal and revisioned rebuild;
- complete deletion of all twenty participants; and
- a final privacy-suppressed aggregate revision.

The contribution contained both `gpt-5.6-sol` and `gpt-5.6-terra` cells. The
smoke derived and exact-checked all eight community metrics for each cell:
usage events, uncached input, cache read, cache write, text output, reasoning
output, combined output, and tool units. It applied the same nullable-sum,
per-participant clipping, support, and rounding rules as the service.

# Harness correction

Two deliberately investigated failures improved the proof:

1. A first attempt used the already-populated inspectable laboratory. The smoke
   correctly rejected that state because its initial invariant requires no
   previously released snapshot. The separate laboratory revision was rebuilt
   after cleanup.
2. A fresh-state attempt reached successful publication but the smoke still
   expected the generated fixture's single event and 900 cache-read tokens.
   The assertion was generalized instead of weakened.

`smoke-http-backend-lib.mjs` now derives every expected provider/model cell and
metric from the validated contribution. It exact-checks the authenticated
comparison and the stored public aggregate. Focused tests cover the original
fixture, multiple cells, clipping, nullable suppression, rounding, and
intentional mismatch rejection.

# Final storage evidence

After the successful destructive smoke:

| State | Count |
|---|---:|
| Active participants | 0 |
| Deleting participants | 0 |
| Accepted contributions | 0 |
| Canonical records | 0 |
| Contribution occurrences | 0 |
| Retained quarantine references | 0 |
| Active sessions | 0 |
| Active devices | 0 |
| Live R2 objects | 0 |
| Digest-only deletion tombstones | 20 |
| Withdrawn immutable snapshots | 2 |
| Final suppressed snapshot | 1 |

The deletion tombstones and immutable snapshot history are intentional
deletion-safety and anti-reconstruction evidence; they contain no participant
authority or source content.

# Rendered product evidence

The in-app browser verified two complementary surfaces:

- the central Worker portal showed the twenty-participant delayed snapshot,
  restored a seeded participant through an owner-only recovery capability, and
  rendered private server-repriced statistics plus accepted contribution
  history; and
- the loopback companion showed real local quota/cost evidence and the live
  public central snapshot together, with separate `Backend ready` and local
  evidence freshness states.

No browser console errors were observed in either rendered journey.

# Automated checks

The focused checks passed:

- consumer UI contract tests: 28/28;
- loopback companion, prepared-set, and foreground-delivery tests: 41/41;
- Cloudflare-runtime Worker tests: 65/65; and
- operator script checks after the real-file assertion fix: 33/33.

The complete product gate is run separately before the source-state handoff.

# Worker review boundary

The running backend uses D1 and R2 bindings directly, streams and bounds request
bodies before JSON decoding, keeps request state out of module globals, uses
cryptographic capabilities rather than predictable identifiers, enables
structured observability, and keeps secrets outside checked-in configuration.
The Worker compatibility date is July 26, 2026.

The review was checked against the current
[Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[D1 prepared statement guidance](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
and [R2 Workers binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

# Remaining gates

- Remote Cloudflare staging resources are not provisioned.
- R2 remains unavailable in the selected staging account.
- External enrollment and collection remain disabled and unauthorized.
- Production backup/restore, retention approval, key rotation, abuse response,
  alerting, consent review, and cross-browser HTTPS QA remain unverified.
- The desktop packaging and ordinary-user installation path remain separate.
