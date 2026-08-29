---
title: Claude Desktop Durable Ledger Decision
date: 2026-08-16
type: decision-record
status: complete
---

# Claude Desktop durable ledger decision

> **Current boundary (source `52399658`, reviewed 2026-08-27):** this record
> preserves the provider-isolated prototype decision and its measured evidence;
> it does not describe a shipping Claude product surface. PR #78 retired the
> experimental local Claude quota route and quota-state integration. The
> installed companion currently exposes no Claude source setting, route, UI, or
> upload surface. Use the maintained
> [architecture](../reference/system-architecture.md),
> [API inventory](../reference/api-surface.md), and
> [privacy inventory](../reference/local-data-and-privacy.md) for current
> product behavior.

## Decision

For the first Claude release, use a separate non-cascading local namespace for Claude
usage, quota, source state, projections, and caches. Do not write Claude facts directly
into the current `local-analysis-index` tables whose source refresh can cascade-delete
usage and quota rows, and do not make a broad provider-column migration of the Codex
production tables as a prerequisite. Existing Codex storage and projections remain
unchanged; Claude product surfaces are added as separate derived projections after
their own production migration.

If a shared boundary is introduced later, its one-way compatibility rule is narrow:
legacy rows with a NULL or empty provider may be interpreted as `openai_codex` during
the transition, then new writes must require an explicit provider. NULL or empty must
never default to Claude, and the compatibility rule must not be used to hide an
unclassified new row.

The Phase 0 implementation is
[`src/claude-desktop-ledger-prototype.js`](../../src/claude-desktop-ledger-prototype.js).
It proves the lifecycle contract but is not yet wired into the installed application.
At this decision's snapshot, an experimental local-companion quota-state path and
closed quota route had also been implemented. Those integration files and the route
were later retired. The remaining
[`src/claude-desktop-plan-history.js`](../../src/claude-desktop-plan-history.js) reader
is used by prototype and benchmark code, not by the installed refresh. Separately,
[`src/claude-desktop-pricing.js`](../../src/claude-desktop-pricing.js) prices a rich
canonical winner through the existing registry and is exercised by the prototype
ledger/incremental path with a separate replay-safe summary cache. It has no production
server call site or installed consumer. Quota ingestion must not be inferred from
pricing.

The prototype now also commits a content-free transcript cursor in the same
transaction as each bounded candidate batch. A restart can reconstruct the frozen
source plan from fresh private inventory paths plus keyed source identities; the
checkpoint itself contains no raw path, session identifier, or transcript content.

## Durable contract

The prototype exercises these separations; the first production Claude namespace must
retain their equivalent without requiring a rewrite of the existing Codex tables:

| Fact | Identity and behavior |
|---|---|
| Source state | `(provider, source_key)` with generation and lifecycle status; disappearance changes state but does not delete accepted facts |
| Usage candidate | Immutable `(provider, candidate_key)` carrying keyed logical/source/model identity, source generation, parser version, token components, and output kind |
| Logical winner | `(provider, logical_key)` points to the deterministic best candidate and records supersession revision |
| Quota revision | `(provider, account_scope, observed_at_ms, meter_id, revision)`; rolling source replacement never deletes accepted observations |
| Coverage gap | Provider/source/time interval and reason; absence and unreadability are unavailable, not zero |
| Projection manifest | Provider generation, ledger high-water mark, payload digest, and publication time; failed builds preserve the last good generation |
| Purge tombstone | Provider and time interval with a content-free receipt; matching raw facts cannot be immediately re-imported |

Within the prototype, provider identity belongs in every uniqueness key, query, and
projection namespace. That provider-keyed mixed test is an isolation guard, not proof
of a Claude calibration or replay-safe cache and not approval for a broad migration of
the current Codex tables. The first Claude production namespace must be independently
scoped and must not collide with Codex. Model names are not provider identity.

## Output contract

Claude's `output_tokens` remains stored as `provider_reported_combined`. A compatibility
view may render:

```text
text = combined
reasoning = 0
```

The zero is a display projection, not evidence that Anthropic reported zero hidden
reasoning. The durable fact retains combined-output provenance. No additional numeric
output column is required in a view that already supports combined provenance.

Pricing must happen from the rich canonical boundary while it still retains the
validated model declaration, cache-write aggregate plus five-minute/one-hour TTL
split, and `provider_reported_combined` output kind. The pricing adapter may project
that fact into the existing accounting vocabulary, but it must not manufacture model
identity, TTL detail, or a text/reasoning split after those fields have been discarded.

## Phase 0 evidence

The prototype tests prove:

- partial-to-final winner supersession rather than additive double counting;
- source disappearance retains the winner and creates a coverage gap;
- conflicting immutable candidate identity fails closed;
- quota correction creates a revision while repeated rolling samples deduplicate;
- failed projection publication leaves the last-good generation unchanged;
- Claude and Codex projections remain provider-isolated;
- provider/time-range purge invalidates Claude projections and tombstones re-import;
  and
- Claude combined output projects to text plus zero reasoning without losing source
  provenance;
- rich pricing inputs survive replay, winner correction, and ledger reopen;
- legacy or incomplete pricing rows remain visibly unpriced, while unknown and empty
  projections cannot become a fully priced zero;
- frozen plans survive JSON serialization without raw paths or content and can be
  reconstructed only by supplying a matching fresh private source inventory; and
- candidate batches and exact byte/line/cost cursors commit atomically, reject cursor
  regression, and resume after a forced ledger reopen.

See the
[`Phase 0 implementation receipt`](../receipts/2026-08-16-claude-desktop-phase0-implementation-receipt.md).

## Production gate

Do not migrate production storage yet. Selective row materialization, bounded SQLite
merge batches, statement reuse, and cursor checkpoints reduced the current-corpus
peak from 1,938,341,888 to 517,439,488 bytes and reduced the checkpoint/preparsed-quota
replay lane from 2,259.246 ms to 32.318 ms with zero candidate reads. A forced ledger
restart completed without duplication.

The follow-on incremental prototype now persists minimized canonical groups and
per-source append cursors across plan generations. It produces byte-for-byte candidate
parity with the frozen exporter, reads zero transcript bytes on a fully unchanged
refresh, parses exactly one suffix line in the one-row append fixture, and preserves
accepted groups after disappearance. Secret mismatch, interval regression, prior-prefix
mutation, and logical/tool invariant conflicts fail closed. SQLite, WAL, and SHM files
are owner-only. Rebuilt sources advance their persisted generation, and that generation
is part of each immutable provider-ledger candidate key instead of being hard-coded.
The refresh also applies aggregate source-byte and canonical-record ceilings.

The isolated current-corpus unchanged refresh completed in 763.630 ms with a
202,817,536-byte lifetime peak under a 256-MiB watchdog ceiling. First import completed
in 36.328 seconds with a 534,249,472-byte lifetime peak under a separate 768-MiB ceiling.

Do not migrate shared Codex production storage yet. After streaming both pricing and ordinary usage
projection, a generated 35,000-row, 15.47-MB lifecycle passes the 768-MiB bootstrap and
256-MiB background ceilings: first import peaked at 325,959,680 bytes and append at
145,948,672 bytes. A read-only aggregate-only density/composition tool now measures
candidate counts without mutating transcripts. After replacing repeated whole-plan
validation with the existing one-time bulk slice, it completed over 1,471 selected
files / 1,377,321,447 bytes and counted 43,812 candidates. Candidate density was p50
8, p99 258.9, and maximum 5,371 per selected source. The
333,643,776-byte prior prototype footprint/compaction decision remains open until a
representative production-shadow database exists.

The provider-isolated shadow controller is now a real but programmatically disabled
local-companion refresh dependency. It adds no route, response field, environment
switch, setting, UI, or upload surface. Ordinary shadow refresh excludes quota parsing,
uses the bounded pricing cache, and keeps dirty canonical groups replayable until all
downstream publications succeed. Explicit purge retains the provider ledger and its
tombstone while deleting only rebuildable canonical/pricing artifacts, preventing raw
source re-import from resurrecting deleted periods.

User-facing production still requires backend/account attribution, capture-window
migration, installed-app authorization and cancellation/progress evidence, a reviewed
shipping quota boundary, a database-footprint decision, and reviewed product
projections. The retired quota experiment, disabled shadow controller, bounded pricing
cache, and prototype usage ledger are not a user-facing Claude support claim.

The disabled production wiring now propagates custom Claude configuration and an
explicit/current project independently from installed resources, while disabled mode
does not validate malformed Claude path variables. Shadow deadlines bound even a
non-cooperative read-only readiness probe and check cancellation throughout secret
setup. Purge preflights both durable stores and every explicit physical artifact before
ledger mutation; partial ranges retain exact before/after coverage gaps and preserve
surviving winner revision provenance.
