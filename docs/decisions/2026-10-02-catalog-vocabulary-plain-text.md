---
title: Catalog vocabulary passes as plain text within the wire grammar
date: 2026-10-02
type: decision-record
status: accepted
---

# Catalog vocabulary passes as plain text within the wire grammar

> **Accepted.** The owner decided this in chat on 2026-10-02 (GCP fast path,
> round 3 amendment at about 14:00 UTC, and round 7 "name guard"). This record
> restates those choices and the invariant wording they changed. It changes no
> current Cloudflare behavior, ships no client change, and authorizes no
> deployment, migration or publication. It contains no identifiers or session
> content.

| Field | Value |
|---|---|
| Decided by the owner | In chat on 2026-10-02: round 3 (plain text, no hashing), its amendment (structural guard only), round 7 (the guard is exactly the v1.x wire grammar), and round 11 (the unseen-name probe's log line may list in-grammar names) |
| Applies to | Model, provider, speed, tier and plan names wherever TiboTattle stores, derives or publishes them |
| Invariant amended | The raw-account-identifier rule in the root `AGENTS.md`, and the free-text rule in `packages/telemetry-contract/AGENTS.md` |
| First implementation | The signed catalog manifest token guard (`catalog-token-guard-v1`, `apps/worker/src/catalog-manifest.ts`) on the GCP fast-path line |

## Decision

1. **Vocabulary, not account identifiers.** Model, provider, speed, tier and
   plan names are vocabulary. The owner states they are not confidential. They
   are not "raw account identifiers" under the product invariant, and they are
   never hashed or pseudonymized.
2. **The guard is exactly the wire grammar.** A name passes as plain text, case
   preserved, when it matches `[A-Za-z0-9._:-]` with 1 to 64 characters, which
   is the v1.0, v1.1 and v1.2 wire token grammar. Nothing else is refused: no
   semantic rule removes ARNs, digit runs, hex runs or account-number-like
   strings. A colon-delimited ARN inside the grammar passes as plain text.
3. **Outside the grammar is `unrecognized`.** A name outside the grammar,
   including ARNs that contain `/` and anything longer than 64 characters, is
   counted as `unrecognized`. It is never refused as an upload, never priced
   as a nearby model, and never converted to zero. Widening the grammar needs
   a successor wire contract version, after cutover, alongside open plans.
4. **Reviewed configuration is stricter.** Inside a signed catalog manifest,
   which is reviewed configuration rather than telemetry, an out-of-grammar
   name is refused outright.
5. **Public surfaces draw only catalogued names.** Unknown names are stored
   and counted, never drawn raw on the public site, until the catalog or
   manifest adds them (round 5).
6. **The unseen-name probe's log line may list in-grammar names (round 11).**
   The unseen-name probe's log line may list in-grammar unseen model, speed,
   tier and plan names, bounded per dimension, with record counts. This is
   the owner's round-11 answer to the question that had held the listing
   against the round-5 log retention wording. A string outside the grammar is
   still only counted, never listed. The answer covers that one line and
   those four dimensions only: listing these names, or provider names, in any
   other log or diagnostic needs a new owner decision.

## What is unchanged

- Prompts, responses, raw commands, credentials, private paths and filenames,
  raw account identifiers and session content remain forbidden in derived
  artifacts, fixtures, logs, diagnostics, issues, commits and pull requests.
- Plans stay a closed roster on the v1.x wire. The manifest can never widen it.
- Uploads are stored exactly as sent. Unseen-name detection runs in analytics
  as content-free counts; there is no intake rewrite (round 7).

## Implementation state and open gates

- **Done on the GCP line (stream KM-CORE):** the manifest token guard, the
  closed manifest validators, and the server catalog store refuse
  out-of-grammar names; `guardCatalogToken` classifies observed values as a
  plain-text token, `unrecognized` or `missing`.
- **Not done:** the client pass-through of unknown names (KC-3), the
  analytics unseen-name counts, the public-site rendering rule, and the
  privacy page and in-app notice update, which the owner placed in the next
  client release (round 5). Until KC-3 ships, clients keep the current
  fingerprint/unknown policy for unknown models.
- **Done on the GCP line (round 11, 2026-10-02):** the owner said yes to the
  K-DETECT unseen-token probe (`apps/worker/cloud-run/unseen-token-probe.mjs`)
  listing in-grammar unseen model, speed, tier and plan names on its Cloud
  Logging line (decision 6). `UNSEEN_TOKEN_LISTING` is `plain`. The probe is
  not scheduled yet (D-OPS4), so no such line has reached Cloud Logging.
