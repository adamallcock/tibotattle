---
title: "Upload the turn boundary bit"
date: 2026-09-20
type: plan
status: proposed
---

# Upload the turn boundary bit

A standalone brief. Everything needed to act is here; no prior context required.

## The problem in one paragraph

TiboTattle publishes a community "cache retention by pause" curve on
tibotattle.com: how often a cached prompt prefix survives a gap of a given
length. The hosted curve measures gaps between **consecutive requests**. The
local dashboard measures gaps between **user turns**. These are not the same
question, and the difference is not cosmetic — a single user turn's tool loop
contributes ten or twenty sub-second adjacencies, so the hosted sub-minute
bucket is swamped by within-turn traffic that no human ever waited through.

## The measured size of the problem

All figures measured, not estimated. Local measurement is against 945,022
real `usage_event` rows (2026-05-17 → 2026-09-20, 8,801 sessions) using
`usage_event_boundary.turn_context_before` as ground truth. Hosted figures are
from the live published payload.

| | hosted (live) | local reproduction |
|---|---|---|
| sub-minute adjacencies | 818,269 | 811,355 |
| 1–2 minute adjacencies | 25,191 | 24,318 |
| ratio | 32x | 33.4x |
| sub-minute reuse rate | 99.1% | 99.1% |

Of those sub-minute adjacencies, only **2.50%** are genuine turn starts. The
published caption already discloses this as "97.6% intra-turn, 49x
over-weight"; independent measurement puts it at 97.5% and 40.1x, so the
caption is accurate.

The consequence for the published number: the sub-minute figure reads **99.15%**
unfiltered against a turn-scoped truth of **83.80%** — a **+15.35pp**
overstatement on the headline bucket.

## Why inference was rejected

Do not spend time re-deriving this. It was tested properly and the answer is no.

The uploaded `usage-event-v1.1` record is a closed schema:
`eventId`, `eventTime`, `sessionUuid`, `provider`, `modelId`, `speedMode`,
`apiServiceTier`, `surface`, `billingSurface`, `reasoningEffort`, `agentScope`,
`outcome`, `totalInputContextTokens`, `components` (six token counts),
`accountPlanAttribution`.

**Four of those fields carry no information at all.** Verified on the hosted
corpus over 164,094 usage rows in one week: `total_input_context_tokens` is
NULL on every row, `input_cache_write_tokens` is never positive,
`output_combined_tokens` is NULL on every row, and `outcome` is the single
string `"unknown"` on every row. This is an upload-projection gap — the local
index holds this data — and is worth a separate investigation.

Single-field proxies, measured in the sub-minute same-configuration stratum
against a 2.50% base rate:

| candidate | AUC | precision | recall |
|---|---|---|---|
| uncached fraction `unc/(unc+cacheRead)` | 0.783 | 25% | 18% |
| `inputUncachedTokens` | 0.686 | 18% | 31% |
| context jump | 0.555 | 15% | 14% |
| `outputReasoningTokens > 0` | 0.494 | fires on 86.8% intra-turn vs 87.4% turn-start |

A gradient-boosted model over 17 derived features reaches AUC 0.990 (92.8%
precision at 84.9% recall) and survives a leakage audit. **It is still not
deployable.** Held out across model families — a far weaker shift than a
different contributor's Codex version, tool mix and prompt style — precision
falls from ~80% to **20.6%**, and the retention estimate lands **−22.30pp**
from truth. The current unfiltered bias is at least known and signed (always
an overstatement); a proxy replaces it with an unsigned error that cannot be
audited, because the hosted side has no ground truth to check against.

Simple proxies are also circular: filtering by uncached fraction selects cache
misses and then reports on cache retention, producing a −17.8pp error.

## The proposal

Upload one boolean per usage event: **did this request begin a new top-level
user turn?**

It is already computed locally. `usage_event_boundary.turn_context_before` is
derived in the local unified index from `turn_context` records in the Codex
rollout log. Nothing new is measured, parsed or retained — an existing local
bit is added to the upload allowlist.

## Where the work is

Read these before changing anything:

- `packages/telemetry-contract/src/telemetry-v1.1-schemas.js` — the closed
  `usage` schema. A new field goes here, and the schema is `closed()`, so
  adding one is a deliberate versioned act.
- `src/contribution/telemetry-v11-chunks.js` and `telemetry-v1-chunks.js` —
  the projection that builds uploadable records. Note how `tokenComponent`
  handles nulls; the same care is owed here.
- `src/local-unified-index.js` — `usage_event_boundary`, schema around line
  445. The `CHECK(compaction_before = 1 OR turn_context_before = 1)` means a
  MISSING boundary row is a valid negative, not unknown evidence.
- `src/local-unified-contribution-attribution.js:200` — the export selection.
  It reads `usage_event` with no join to `usage_event_boundary`, so the join
  is part of this work.
- `apps/worker/src/cache-retention-values.ts` — `CACHE_RETENTION_METHOD`, the
  frozen method object, and `reduceCacheRetentionDay`, which is where the new
  bit would gate the population.
- `apps/worker/src/cache-retention-day.ts` — `cacheRetentionEventFromRecord`,
  the strict mapper.

## Constraints that are not negotiable

1. **Three states, not two.** Old clients will never send this bit. The
   hosted side must distinguish "this was a turn start", "this was not", and
   "this client does not report it". Treating absent as false would silently
   reclassify every historical record and every un-upgraded device as
   intra-turn. Absent is absent.

2. **No retrofit.** The bit only covers records uploaded after the release.
   The existing corpus can never carry it. Plan for a curve that starts empty
   and fills, alongside the request-scoped one, rather than a migration.

3. **Two populations must not merge.** Once some devices send the bit and some
   do not, a single curve over both is neither measurement. Use the
   `method_version` mechanism already in `CACHE_RETENTION_METHOD` — changing
   any rule there fails a pinned digest test until the version is bumped and
   the migration's closed `method_version` enum is widened. That ratchet
   exists for exactly this and works.

4. **Privacy.** A boolean derived from turn structure carries no prompt,
   response, path or identifier, which is why this is the right fix rather
   than uploading timestamps or context sizes. Keep it that way: do not add
   a turn id, a turn index, or anything that could correlate sessions.
   `SECURITY.md` and the accountless sharing policy in
   `docs/decisions/2026-09-04-accountless-sharing-policy.md` govern.

5. **The schema is closed and mirrored.** A field change means the validator,
   the browser mirror, fixtures, compatibility declarations and migration
   behaviour, in one change. `npm run scripts:check` and the
   telemetry-contract tests enforce this.

## A second, possibly larger finding to scope alongside

`total_input_context_tokens`, `output_combined_tokens` and
`input_cache_write_tokens` are in the contract, are populated locally, and
arrive hosted as null/zero on 100% of rows. Before adding a field, find out
why three existing ones are being dropped — the same projection bug may be in
the path this work would extend.

## What "done" looks like

- A device on the new client uploads the bit; a device on the old one does not,
  and both are accepted.
- The hosted curve can be computed turn-scoped, request-scoped, or both, and
  each is labelled for what it measures.
- The turn-scoped sub-minute figure lands near **83.8%**, not 99.15%.
- No population mixing: a reader can always tell which measurement they have.

## One thing this does not fix

**22.35% of same-configuration adjacencies share an identical millisecond**
(13.3% on the hosted corpus — 109,109 of 818,269 sub-minute adjacencies).
Locally these are ordered by `source_offset`; the hosted record carries only
`eventTime`, so for a seventh of the headline bucket the order of two requests
cannot be established at all. This is independent of the turn question and
needs its own decision. The method already counts these as `unorderedTies` and
publishes the count, which is the honest minimum, but nothing surfaces it.
