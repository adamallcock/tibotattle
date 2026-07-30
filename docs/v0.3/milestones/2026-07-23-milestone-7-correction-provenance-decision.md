---
title: Milestone 7 Correction Provenance Decision
date: 2026-07-23
type: decision-record
status: complete
---

# Milestone 7 Correction Provenance Decision

## Decision

**Proceed to final validation.** The append-only correction gate passes. The retained schema-0.1 observation was not rewritten, the deterministic migration appends one correction exactly once, and the effective view removes the replayed unknown-model bucket and active warning while retaining a visible original-versus-effective audit trail.

## Required migration result

| Measure | Retained original | Effective view |
| --- | ---: | ---: |
| Aggregate local tokens | 2,963,770,014 | 2,892,709,515 |
| Replayed fork-history tokens | 71,060,499 included | Removed |
| API-price-equivalent cost | $1,668.23595870 | $1,668.23595870 |
| Active `unknown_model` warning | Present | Absent |
| Unknown-model events | 471 | 0 |
| Priced events | 20,195 | 20,195 |

The dollar estimate is unchanged because the legacy unknown bucket was already unpriced. The corrected API-pricing components are:

- uncached input: 95,758,355;
- cache-read input: 2,788,823,040;
- cache-write input: 0;
- text output: 5,527,686; and
- reasoning output: 2,600,434.

## Correction record

The owner-only append log contains one schema-0.1 `derived_observation_correction`. It records:

- its immutable correction ID and superseded observation ID;
- the lineage replay-deduplication reason and category;
- a fixed creation timestamp;
- parser, estimator, pricing, and lineage-method versions;
- digests of the original derived value, complete target record, replacement derived value, and frozen transition artifact;
- replacement aggregate fields and diagnostics;
- source coverage for the fixed transition interval; and
- an aggregate-only operator note.

It does not include prompts, responses, commands, tool arguments, source paths, session/rollout IDs, credentials, or account/device identifiers.

## Resolution behavior

The resolver:

1. leaves every input object unchanged;
2. validates the predecessor digest at every hop;
3. follows one deterministic supersession chain;
4. collapses byte-identical duplicate correction records;
5. refuses branching corrections without choosing a winner;
6. reports cycles, missing targets, digest mismatches, correction-ID conflicts, and incompatible schemas;
7. preserves schema-0.1 observation compatibility; and
8. emits both original and effective derived values plus correction history.

It revalidates privacy on read, rejects unsafe identifiers without echoing them into errors/reports, and holds an owner-only exclusive lock across the migration's read-plan-append transaction.

Corrections replace the derived analytical view only. Provider quota fields, official daily buckets, ccusage evidence, and raw provider/client logs are not altered.

## Immutability and idempotency receipts

- `.usage-monitor/observations.jsonl` SHA-256 before migration: `965118ca1fbb0fadc9644e3b3909ee5066bd728bdbeac6253c86075ce1ee3e69`.
- SHA-256 after the first and second migrations: the same value.
- Correction log after the first migration: one line.
- Correction log after the second migration: still one line.
- Correction log SHA-256 after both runs: `c04d1199b7a2db675577a7c15f01bafeb951eb1c89cb5cfa59ec99f606bdfa35`.
- Effective artifact SHA-256 after both runs: `d553586246d341c58ad5f0d9d2006ba2ac56512a5fb69acd6b624070de7b31e3`.
- Human report SHA-256 after both runs: `a7c13a54ccd6a8eb220628e2732d13668ee555d80cb54b9c67ebb0cc912929c4`.

The second command reported `already applied`; it made no append and reproduced the same effective files.

## Collector-only unknown records

The 22 early passive-collector records labelled `unknown` are distinct from the 71,060,499 replay bucket corrected here. They total 3,714,307 tokens, are consumed by no canonical analytical pathway, and cannot be safely re-attributed from their privacy-minimized fields. They remain byte-preserved operational provenance. The observation correction ledger intentionally does not manufacture an event-level correction for data outside its input model; a future collector analysis would require its own disposition schema.

## Source coverage

The correction references the frozen Milestone 1 transition artifact rather than a moving rescan:

- fixed interval: `2026-07-21T17:06:03.000Z`–`2026-07-23T16:15:40.974Z`;
- 119 files in the frozen materialization;
- 20,195 retained usage events;
- 35,181 fork replay events excluded;
- zero missing lineage parents;
- zero partially priced events; and
- five malformed lines retained as diagnostics.

## Validation receipts

- Correction and migration tests: 15 passed, 0 failed.
- Full suite: 88 passed, 0 failed, 0 skipped.
- JavaScript syntax checks: all source files passed.
- Resolution: two original observations, one compatible correction, two effective observations, zero conflicts, zero errors.
- New JSON/JSONL artifacts: zero forbidden privacy-key or sensitive-string hits.
- Correction, effective, and report files: mode `0600`.

## Artifacts

- `.usage-monitor/corrections-v0.3.jsonl`
- `.usage-monitor/effective-observations-v0.3.json`
- `.usage-monitor/2026-07-23-correction-report.md`
- `src/corrections.js`
- `src/correction-migration.js`
- `test/corrections.test.js`
- `test/correction-migration.test.js`

## Gate verdict

`proceed` — all required correction, legacy, audit-trail, immutability, privacy, and idempotency checks pass.
