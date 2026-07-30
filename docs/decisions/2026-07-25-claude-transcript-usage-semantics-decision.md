---
title: Claude Transcript Usage Semantics Decision
date: 2026-07-25
type: decision-record
status: accepted
---

# Claude Transcript Usage Semantics Decision

## Decision

Treat one Claude provider `message.id` as one logical usage event. Claude Code transcript `assistant` rows are incremental content-block snapshots, not independent billable requests. The exporter must canonicalize all frozen transcript rows globally before emitting a usage event:

1. group by raw `message.id` only in bounded local memory or a private disk-backed index;
2. discard the raw ID after deriving a domain-separated secret-keyed occurrence material;
3. require model, session, input, cache-read, cache-creation, and agent/scope evidence to agree across the group;
4. retain the deterministic occurrence with maximum `output_tokens`, breaking equivalent ties by canonical timestamp and frozen physical position;
5. aggregate tool classes once per distinct tool-use block ID across the grouped content-block rows, without persisting the raw block ID or tool name;
6. bind the selected physical occurrence and safe aggregation result into the private frozen plan; and
7. emit exactly one canonical usage event whose ID derives from the secret-keyed logical message occurrence, not from a duplicated physical transcript line.

A conflicting group fails closed or produces a reviewed content-free diagnostic; it is never summed, guessed, or silently last-write-wins. Direct row-per-line export is prohibited.

## Evidence

A content-free local scan on 2026-07-25 inspected JSON structure and numeric usage fields only across 1,138 owner-local Claude Code transcript files. It did not print or retain paths, prompts, responses, tool arguments/results, raw message/session/request IDs, branches, titles, or attribution strings.

| Observation | Count |
|---|---:|
| Assistant rows with usage | 63,756 |
| Unique provider message IDs | 22,596 |
| Repeated physical rows | 41,160 |
| Message IDs appearing in multiple files | 2,042 |
| Duplicate groups with identical usage on every row | 10,676 |
| Duplicate groups whose output count changes | 7,410 |
| Duplicate groups where the last output equals the maximum | 18,086 of 18,086 |
| Cross-file groups spanning more than one session | 0 |
| Cross-file groups with different partial output values | 30 |

Input, cache-creation, cache-read, and model values were constant within every observed duplicate group. Output was cumulative across incremental rows. Choosing one final/max observation per logical message instead of summing physical rows changes the observed corpus totals as follows:

| Component | Incorrect row sum | Logical-message final total | Overcount factor |
|---|---:|---:|---:|
| Uncached input | 36,636,663 | 12,994,665 | 2.819× |
| Cache creation/write | 717,638,038 | 197,145,501 | 3.640× |
| Cache read | 16,146,099,919 | 5,341,615,529 | 3.023× |
| Provider-reported combined output | 82,111,504 | 29,244,473 | 2.808× |

These totals are structural validation evidence, not an allowance or price estimate.

## Token-component semantics

The canonical event maps Anthropic usage fields according to the current [Messages API reference](https://platform.claude.com/docs/en/api/messages):

- `input_tokens` → uncached input;
- `cache_creation_input_tokens` → cache creation/write;
- `cache_read_input_tokens` → cache read; and
- `output_tokens` → provider-reported combined output.

Anthropic documents total input as the sum of those three input components. The exporter therefore does not subtract cache fields from `input_tokens`. It does not split `output_tokens` into visible text and reasoning, even when transcript content contains text or thinking blocks.

## Privacy boundary

Raw provider message IDs and tool-use block IDs remain prohibited output. The private source plan may retain only domain-separated secret-keyed occurrence material, frozen source/line coordinates, safe numeric components, and reviewed low-cardinality classifications needed to reproduce the canonical event. The exported event exposes only the existing domain-separated event/session pseudonyms.

## Required acceptance evidence

- Partial-row, cumulative-output, and repeated-tool fixtures.
- Cross-file duplicate and partial-copy fixtures.
- Conflicting session/model/input/cache/scope fixtures that fail closed.
- Determinism under discovery reordering and restart.
- Bounded disk/memory and non-quadratic prefix validation.
- Real local content-free smoke proving emitted event count matches logical-message count for the selected interval.
- Full privacy/schema/compatibility and Node 24/26 matrices.

Until this evidence passes, Claude transcript usage remains `not_implemented` even if a standalone parser exists.
