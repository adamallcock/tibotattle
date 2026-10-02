---
title: Unintegrated analytics draft checkpoint
date: 2026-10-02
type: review
status: paused-draft
---

# Preserved drafts

This record preserves work at the October 2 maintenance pause on branch
`codex/maintained-analytics-framework`, based on commit
`f056940fefabed0c7f0e88353cf54845b077f0c8` and its integrated candidate changes.
The owner subsequently authorized a complete commit and push. Implementation and
native qualification remain paused. These packets are unapplied review artifacts;
the production source, migration and test directories retain the integrated
candidate described in the [pause receipt](../receipts/2026-10-02-analytics-maintenance-pause.md).

## Source and test packets

| Packet | State and next gate |
|---|---|
| [Maintained shared-window source](./2026-10-02-analytics-drafts/2026-10-02-shared-window-maintained-proof-source.patch.json) | Two-file proposal; reviewed direction and stubbed disposal controls; actual D1 validation pending. |
| [Shared-window controls](./2026-10-02-analytics-drafts/2026-10-02-shared-window-maintained-proof-controls.patch.json) | Fifteen additive controls; run the genuine baseline first. |
| [Canonical 101-day density control](./2026-10-02-analytics-drafts/2026-10-02-shared-window-maintained-proof-dense.patch.json) | Genuine canonical producer/coverage fixture; native execution pending; original default-path controls remain required. |
| [P11 B2 transition census](./2026-10-02-analytics-drafts/2026-10-02-p11-c06-b2-v1.patch.json) | Six-file proposal; prior 33 pure/56 launcher checks and virtual typecheck; no native execution or append-ACK qualification. |
| [Terminal erasure v5](./2026-10-02-analytics-drafts/2026-10-02-terminal-selective-erasure-v5.patch.json) | Narrow real-erasure-order proposal; unreviewed and untested; integrated v4 still has three selected failures. |

The [manifest](./2026-10-02-analytics-drafts/2026-10-02-analytics-draft-manifest.json)
records exact patch checksums, source base/result checksums and protected validators.
The shared-window [design](./2026-10-02-analytics-drafts/2026-10-02-shared-window-maintained-proof-design.md)
and [review](./2026-10-02-analytics-drafts/2026-10-02-shared-window-maintained-proof-review.md),
and the [terminal review](./2026-10-02-analytics-drafts/2026-10-02-terminal-selective-erasure-v5-review.md),
retain the integration reasoning and refusal boundaries.

## Exact recovery

Each JSON packet stores the original unified diff as UTF-8 lines, including
significant diff whitespace. To reconstruct a patch, concatenate `patchLines`,
encode as UTF-8, and require its byte length and SHA-256 to match `patchBytes` and
`patchSha256` before writing or applying it. Review actual target file hashes and
run `git apply --check` against the current candidate before any source adoption.
All five reconstructed packets passed that check at capture; none was applied.

A verified local recovery archive separately preserves all 318 integrated changed
files and 57 curated draft/evidence files. Raw local runtime inventories, full test
logs and obsolete execution controllers stay in that recovery archive. Their old
pins and once markers are not current execution authority. Rebuild complete native
input pins and use fresh controller prefixes when work resumes.

## Resume boundary

Follow the [pause receipt's resume order](../receipts/2026-10-02-analytics-maintenance-pause.md#resume-order).
Preserve strict public outputs, publication timestamps, native source/erasure/CAS
fences, existing failure assertions, resource caps and both validators. P0-P11,
the final frozen owning gate and H06/H07 remain incomplete. This checkpoint proves
preservation; it does not qualify performance, migrations, activation or production.
