---
title: G5 Server Repricing and Calibration Verification Receipt
date: 2026-07-26
type: verification
status: verified_checkpoint
---

# G5 Server Repricing and Calibration Verification Receipt

## Decision

The G5 server-repricing slice is a verified private-development checkpoint.
The central service can accept a bounded privacy-safe contribution, reject
invalid telemetry, recompute API-price-equivalent cost from allowlisted token
metadata, persist price provenance in D1, return participant-private cost and
rolling quota comparisons, publish the existing privacy-safe weekly community
snapshot, and delete the participant's derived state.

This is not authorization for a public deployment or participant solicitation.
The server-side rolling result fails closed because the v0.1 contribution
deliberately does not transmit account continuity. Public cost-versus-quota
metrics also remain outside the community snapshot pending a separate privacy
analysis.

## Canonical accounting boundary

- Pricing method: `server-api-price-equivalent-v0.1`
- Registry: `app-official-api-prices-v0.1`
- Registry observation: `2026-07-26T07:21:54Z`
- Registry SHA-256:
  `c9961d3d0d5de61b7471f1322ed7ce3b75be184a8dddb59450746ed6eb30f71f`
- Canonical event cost: exact decimal string plus exact integer nanousd
- Client-declared cost: retained only as an unverified diagnostic
- Codex subscription Fast: retained as a speed observation and priced against
  the Standard API counterfactual, never silently mapped to API Priority
- API Standard, Batch, Flex, and Priority: selected only when the event is on an
  API billing surface with that explicit tier
- GPT-5.6 long context: exact 272,000-token boundary; unsupported Priority
  long-context pricing and missing total context fail closed
- Tool classes: observed separately and not billed unless an exact
  provider-billable tool unit is present

Official price evidence:

- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5.6 Terra model](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

## Implemented product path

1. The local exporter reads the private rollout directory and emits a canonical
   metadata-only bundle plus a hash-bound privacy receipt.
2. The contribution builder re-verifies that pair, removes private
   account/session/provider scopes, and splits it into closed files of at most
   200 records and 1.25 MB.
3. The browser validates the closed schema, encrypts the contribution, and
   obtains a one-use authorization bound to the exact digest, byte length, and
   content type.
4. The Worker decrypts, validates, server-reprices, deduplicates, and commits
   the contribution and normalized records through one D1 batch. The opaque
   encrypted envelope is retained in R2 quarantine.
5. The participant-private API returns server-repriced totals, coverage,
   Standard/Fast separation, and quota tracks. The bounded one-, two-, and
   three-hour UTC rolling machinery fails closed until account continuity is
   approved.
6. Deletion removes participant records and R2 objects and withdraws any
   dependent immutable community snapshot.

## Verification evidence

### Real local-data preparation

A fresh July 24 export was generated from 93 local source files:

- 7,968 usage events
- 8,109 quota snapshots
- 16,077 total safe metadata records
- 19,793,453 canonical bundle bytes
- all seven privacy checks passed
- 81 bounded contribution files produced

The archived pre-change export receipt was rejected with the stable
`receipt_schema` error, confirming that an outdated receipt cannot be used as
current evidence.

### Real HTTP backend lifecycle

The invite-only Worker ran on loopback with isolated local D1 and R2 state. The
smoke enrolled 20 participants and uploaded the first real 200-record
contribution for each participant. It verified:

- Secure, HttpOnly, SameSite=Strict session issuance;
- same-origin CSRF and separation between personal and upload authority;
- digest- and byte-bound one-use encrypted uploads;
- strict validation, D1 ingest, R2 quarantine, and server-recomputed personal
  statistics;
- idempotent replay;
- delayed immutable community publication at 20 participants;
- byte-stable reads through both public aliases;
- recovery rotation, security reset, logout, export, contribution deletion,
  snapshot withdrawal, and participant deletion.

Final isolated-state inspection returned:

| State | Count |
| --- | ---: |
| Participants | 0 |
| Contributions | 0 |
| Telemetry records | 0 |
| Sessions | 0 |
| Upload authorizations | 0 |
| Recovery receipts | 0 |
| Snapshot builders | 0 |
| Retained snapshot tombstones | 1 |
| Withdrawn snapshot tombstones | 1 |
| R2 blobs | 0 |

### Automated checks

`npm run product:check` passed:

- 20 browser/UI contract tests
- 10 local companion and contribution-builder tests
- current generated Worker bindings
- Worker TypeScript check
- local operator-script checks
- 37 Cloudflare-runtime integration tests
- Worker deployment dry run, with no deployment

The focused pricing/calibration/transport suite passed 49 of 49 tests. It
includes client-price tampering, Standard/Fast separation, explicit API tiers,
the 272,000-token long-context boundary, unknown model and missing-context
failure, exact provider tool units, account/plan reset separation, weekly
chronological holdout behavior, and contribution materialization.

A focused read-only code-quality audit then identified four correctness gaps.
The final implementation:

- refuses any server quota conversion while account continuity is absent;
- rejects future account-scoped intervals containing stale, backward, or
  incompletely priced evidence;
- uses exact nanousd rather than per-event microusd rounding and fails an
  outsize event closed before participant aggregates can exceed the safe
  integer bound; and
- labels pre-migration/unbackfilled records as unavailable rather than
  server-repriced zero.

### Rendered browser checks

The Worker-served portal was inspected over loopback HTTP. It rendered:

- the intentional no-local-companion state without substituting demo values;
- a labeled full dashboard with five-hour and seven-day quota cards,
  API-price-equivalent components, measured-versus-calculated comparison,
  residuals, exact UTC periods, weekly history, uncertainty, coverage, known
  gaps, privacy boundary, and contribution controls;
- populated one-, two-, and three-hour rolling demo charts; and
- participant-v0.2 priced, partial, unpriced, Fast, ambiguous-account, and
  not-testable states in browser contract tests.

The complete cookie-authenticated personal journey was tested by the HTTP
cookie-jar smoke because a `Secure` session cookie cannot be established over
plain loopback HTTP. A production-shaped HTTPS preview remains a release gate.

## Remaining gaps

- The server cannot safely partition two provider accounts because the outbound
  v0.1 schema intentionally removes account scope. The private rolling result
  therefore returns `not_testable` with
  `account_continuity_not_transmitted`.
- A contribution-local, domain-separated account-track pseudonym needs a
  separate minimization and consent review before private weekly/five-hour
  calibration can match the local analyzer.
- The current server fit is a descriptive within-reset API-price gradient. It
  does not yet reproduce the full local weekly chronological holdout and error
  model.
- Public community cost, quota, residual, or capacity fields need a separate
  linked-equation privacy review, participant clipping, support thresholds,
  rounding, delayed release, and suppression design.
- Exact event prices are persisted as decimal strings, while queryable
  aggregates use exact fixed-scale nanousd for all current reviewed price-card
  divisors.
- Claude-compatible interfaces remain available, but production Claude
  collection and calibration are paused.
- No remote D1, R2, custom domain, production secrets, alerting, backup,
  retention enforcement, incident drill, or public deployment was created.

## Next release gate

The next useful increment is an approved optional account-continuity field,
followed by server parity with the local five-hour/seven-day calibration and an
HTTPS participant pilot. Public aggregate calibration should proceed only
after that private path is accurate and the separate privacy analysis passes.
