---
title: Codex compressed history implementation evidence
date: 2026-09-03
type: review
status: verified-synthetic
---

# Codex compressed history implementation evidence

This records source and synthetic-runtime validation on the uncommitted
`codex/release-0.1.18` worktree, based on `9e1c3333`, using Node 26.2.0. It is
not installed-app, real-history performance, signed-release, or deployment
qualification. The maintained contract is the
[unified index reference](../reference/unified-index-schema.md#compressed-codex-histories).

## Implemented scope

- Native streaming Zstd with explicit unsupported-runtime fallback; no package
  addition, shell decompressor, source rewrite, or decoded temporary file.
- Physical file identity/size separated from logical decoded bytes, offsets,
  history-base cutoffs, source fingerprints, and checkpoint prefix hashes.
- Canonical plain/compressed twin deduplication by decoded SHA-256; divergent
  representations retain the existing thread quarantine policy.
- Direct scans, paginated parent/child histories, single/worker rebuilds,
  incremental replay/representation changes, and legacy inline checkpoint
  batch/resume paths share the bounded adapter.
- Durable checkpoint commits verify a decoded complete-line boundary. The
  preexisting paginated-checkpoint refusal remains explicit.
- Fixed content-free failures, independent frame/block completeness validation,
  native checksum validation, byte/expansion/window/runtime bounds, and abort
  propagation. Plain-source discovery concurrency remains unchanged; no more
  than two compressed discovery decoders run at once.

The passive collector intentionally remains the live/plain-JSONL lane. A
synthetic test proves cold compression does not rewrite its already-retained
cursor or records; historical compressed coverage comes from the unified index
and provider scanner.

## Measured failure corrected

Native Node 26.2.0 `zstdDecompressSync` returned empty bytes for synthetic valid
frames truncated before their end. A successful native EOF is therefore not
proof of a complete source. Independent constant-memory structural validation
now refuses every truncated prefix of a synthetic checksummed frame. Tests also
cover raw, RLE, concatenated and skippable frames, corrupt checksums, oversized
windows, malformed input and complete/incomplete JSONL tails. The structural
checks follow the [Zstandard format](https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md).

## Validation

- New compressed suite: 10 tests passed, including logical cursor and
  source-immutability checks, full/worker/incremental accounting parity,
  representation transition replay, lineage quarantine, cancellation and
  resource refusals.
- Final compressed/checkpoint/resource cohort: 52 tests passed across
  `codex-compressed-rollouts`, `export-checkpoint-equivalence`,
  `export-source-plan`, `local-export-resource-context`, `export-resource-policy`,
  `export-workspace`, and `export-checkpoint-workspace`.
- Earlier scanner/port/reader cohort: 81 tests passed. Broader unified-index,
  rollout-hardening, provider-boundary, source-plan and checkpoint cohort:
  158 tests passed before the final workspace-boundary integration; the final
  52-test cohort explicitly exercises that integration.
- Documentation governance, architecture boundaries, whitespace checks and
  20 preflight tests passed.

## Remaining gates and limitations

Native Zstd capability is required; Node 22.13.0 remains importable but cannot
decode compressed histories. The unavailable capability is tested through the
injected platform seam, not an actual Node 22.13.0 process. [Node API](https://nodejs.org/api/zlib.html#zlibcreatezstddecompressoptions)

Compressed discovery validates complete streams to establish logical lengths
and decoded identity. Seeking a logical checkpoint boundary decompresses its
prefix again. This deliberately avoids unbounded memory or transcript files,
but large-history refresh and checkpoint performance remain unmeasured. No real
Codex history, credentials, source-content capture, R7 regeneration, app install,
release, or publication was used for this evidence.
