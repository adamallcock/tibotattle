---
title: History coverage false positive diagnosis
date: 2026-09-22
type: review
status: implemented
---

Installed TiboTattle 0.1.23 (build 1030) excludes two sources because of one
parser false positive and its dependent lineage exclusion. The initial diagnosis
was read-only; the authorized source repair and copy-only rehearsal are recorded
below. No source history or live index was changed. This is not installed-app
or release qualification. Private paths, identifiers, and record contents are omitted.

## Verified evidence

The installed companion's published generation 251, completed at
2026-09-22T11:50:24.580Z, contains 9,886 discovered sources, 9,884 indexed
sources, and two excluded sources across two threads:

| Source | Recorded reason | Published source size |
| --- | --- | --- |
| A | `codex_rollout_content_invalid` | 3,639,868 bytes |
| B | `codex_rollout_lineage_invalid` | 36,246 bytes |

Source A subsequently grew. Reproduction deliberately reads only the byte
range attested by that publication. All 351 complete records in that range
parse as valid JSON. Its persisted diagnostics show one malformed accounting
record, zero malformed usage records, and zero malformed JSON lines.

Record 89 is a valid, newline-terminated `event_msg` / `item_completed` record
of 119,861 bytes including its newline. Its nested payload contains a JSON
string value equal to `turn_context`, within the first 65,536 bytes.
It is not a top-level `turn_context` accounting record.

The default line reader retains at most 65,536 bytes per line and delivers an
oversized line prefix with `partial: true`. The extractor searches for
accounting marker strings anywhere in that prefix. The nested marker therefore
passes both the relevance filter and `accountingMarker`, incrementing
`malformedAccountingRecords`. One such count quarantines the entire source.

Source B has three valid JSON records and no token-count records. Its metadata
references source A as its parent; the parser classifies B as an inline fork.
The ingestion dependency check excludes B when A is unavailable. B's own
content extraction produces no quarantine reason.

## Reproduction boundary

The installed ASAR's extractor and incremental-ingestion files are byte-identical
to checkout `9385bad2`. The installed line reader differs from the checkout only
in caller-owned handle detection. Reproduction also used the exact installed
line-reader code through an in-process module load hook, with read-only path
inputs and discarded event callbacks. Workspace package resolution was supplied
in-process because this checkout has no installed workspace links.

| Read-only extraction | Malformed accounting | Malformed usage | Content quarantine |
| --- | --- | --- | --- |
| A, default 64 KiB line cap | 1 | 0 | Yes |
| A, diagnostic 512 KiB cap | 0 | 0 | No |
| B, default 64 KiB line cap | 0 | 0 | No |

Both A runs recognize the same 41 token-count records. Increasing the cap was
an isolated diagnostic experiment, not a proposed production fix or a change
to the app. It demonstrates that valid record truncation triggers the false
positive. It does not qualify accounting totals or lineage replay in isolation.

## Repair boundary

The relevant owners are `src/platform/rollout-line-reader.js`,
`src/local-unified-index-extract.js` (`relevant`, `accountingMarker`, partial-line
handling, and `rolloutContentQuarantineReason`), and
`src/local-unified-index-ingest.js` (`dependencyUnavailable`).

A repair should distinguish top-level accounting record identity from nested
payload strings while retaining bounded reads and genuine malformed-accounting
quarantine. Synthetic regression coverage should include oversized unrelated
records with nested accounting markers and genuinely incomplete accounting
records. Recovery must re-evaluate retained quarantines and dependent sources;
simply changing the parsing condition does not prove unchanged quarantined
sources will be retried. No repair, rebuild, installation, or publication was
performed during this diagnosis.


## Authorized implementation

The owner requested structural classification, a 512 KiB limit, recovery tests,
and copy-only rehearsal, with shipping owned by the existing 0.1.24 release
coordination task. Implementation is based on release candidate `60b9cf52`,
not the older diagnosis checkout. Parser v18 advances the candidate's v17 while
preserving its exact totals, turn boundaries, model/tier provenance, and dormant
v1.2 contribution contracts.

- Complete bounded JSON records use their actual outer type and immediate
  event payload type, including JSON member-order and duplicate-member semantics.
  This avoids an early header conclusion hiding a later effective accounting type.
- Oversized or malformed records use a separate structural header reader limited
  to 4 KiB. It never searches nested payloads for markers. Unknown, missing, or
  ambiguous incomplete headers remain unavailable. Empty separators are ignored.
- Huge compactions retain their existing content-free header fast path. The line
  reader now retains at most 512 KiB before skipping the rest of an oversized line.
  Genuine oversized accounting still triggers source quarantine; extractor-level
  partial salvage is not permission to publish verified accounting facts.
- The same classification protects workspace and quota-only carry from unrelated
  nested markers. Malformed unknown contexts clear workspace carry regardless of
  whether quota-only observation is enabled.
- The parser stamp and its provenance variants advance to v18. The explicit cold
  refresh transition accepts reviewed v10 through v17 published generations.
  Existing source fingerprints must actually be reprocessed; absent historical
  sources retain their existing facts and original provenance.

## Scoped private recovery rehearsal

An owner-only SQLite online backup preserved the installed publication and its
salt. A disposable candidate used that full index plus copies of the two
excluded source prefixes at the exact byte lengths attested by generation 251.
This deliberately qualifies recovery of this pair and preservation of retained
facts, not a full-corpus rescan or an installed refresh.

The repair rescanned both sources, removed both quarantine flags, and admitted
41 usage events. All 974,913 preexisting usage rows were retained byte-for-byte
at the SQL-value level, including token columns and provenance. The candidate
contains 974,954 usage events. A new-process repeat inserted zero usage events
and performed zero parser-version rescans. Usage rows, quota occurrences,
canonical quota observations, tool facts, and usage boundaries retained identical
semantic rows on that repeat (generation/run bookkeeping excluded where it
changes). SQLite quick checks returned `ok`.

The scoped copy still reports `tool_provenance_incomplete`: other historical
sources were intentionally absent from this rehearsal, so their old evidence
was retained without claiming new tool qualification. Zero source quarantines
must not be presented as complete all-history/tool coverage.

## Validation and release handoff

Synthetic regressions cover nested markers beyond the new cap, actual malformed
and oversized accounting, ambiguous headers, whitespace/escaped discriminators,
complete member-order and duplicate-member behavior, workspace/quota carry,
the exact 512 KiB boundary, recovery of an unchanged excluded parent and child,
and repeat-ingest idempotency. Mixed old/new parser rows remain readable under
explicit provenance qualification; unsupported future rows remain refused.

Validation passed: 268 focused parser/reader/compatibility/server tests;
82 adjacent accounting/timing/resource-context tests; the recovery/hardening
batch passed 145 of 146 initially, with its one stale future-v18 rejection
fixture advanced to v19 and the complete affected accounting suite then green.
Architecture checks and the 20-test documentation/preflight gate passed.
No assertion was weakened: future-parser rejection remains tested.

A bounded synthetic performance check used 134,711,751 bytes: 4,096 unrelated
`item_completed` envelopes with 32 KiB filler plus 64 accounting records.
Across three passes per process, candidate v18 averaged 81.7 ms versus v17's
24.8 ms; process peak RSS was 133.7 MB versus 163.8 MB. Both recognized the same
64 accounting records with no quarantine. These are warm local microbenchmarks,
not a full-corpus or peak-release-memory qualification. Full bounded parsing
adds CPU to preserve actual JSON member semantics; oversized tails still have
bounded storage and compactions retain their prefix-only fast path.

The final commit and evidence are supplied to the release owner. Combined root/surface gates, a full-corpus refresh, the installed
artifact, and publication belong to that release task. No installed state,
timing-store rows, hosted facts, transport ranks, or correction history were
modified by this work.
