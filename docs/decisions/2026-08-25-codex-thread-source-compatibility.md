---
title: Codex thread-source compatibility and binary diagnostics
date: 2026-08-25
type: decision-record
status: complete
---

# Codex thread-source compatibility and binary diagnostics

## Decision

Codex `session_meta.payload.thread_source` remains an input to TiboTattle's
fixed, privacy-safe classification, not a field whose raw value crosses into
local projections or contribution records. Reviewed values map to `user`,
`subagent`, or `automation`; the exact paired markers accepted on 2026-10-07
also map to local `auto_review`. Absent, malformed, and unreviewed feature labels
map to `unknown`. Other bounded metadata may still establish a safe surface,
such as `cli_exec`, without assigning an unsupported agent scope.

Codex 0.149.1 allows exec and TypeScript SDK callers to attach arbitrary
feature labels, and detached memory requests use `memory_consolidation` in
request metadata. Neither fact justifies treating every new string as a new
public dimension. `automated_review` is not assumed to mean a scheduled task,
and `memory_consolidation` is not assumed to be a persisted billable rollout.
Both remain `unknown` until retained local evidence and provider semantics
support a reviewed low-cardinality mapping.

## What thread source powers

The safe classification derived from thread source is attached to local usage,
quota, and tool observations. Its `surface` and `agentScope` fields power local
surface breakdowns, agent-scope breakdowns, contribution metadata, calibration
slices, and content-free scanner diagnostics. The reduced `threadSource` itself
is retained in the local source index and private diagnostic counts.

Thread source does not determine token quantities, model pricing, speed
pricing, quota windows, account identity, fork ancestry, replay suppression, or
source deduplication. The reviewed local auto-review category additionally
selects the allowance reporting policy described below. Missing a new label
therefore creates attribution drift:
automated or system work can accumulate under `unknown` or a generic local/CLI
surface. It does not drop usage or change its API-price equivalent. A guessed
mapping would be worse because it could make the same usage confidently appear
under the wrong surface.

## 2026-10-07 auto-review amendment

The owner-approved local category `auto_review` requires both exact retained
`session_meta.payload` markers: `thread_source === 'guardian_review'` and
`source.subagent.other === 'guardian'`. Every property in those paths must be
an own data property. A model such as `gpt-5.6-auto-review`, either marker alone,
near strings, inherited values or accessors cannot establish the category.
`automated_review` remains unreviewed. The classifier retains the original
surface, agent-scope and lineage calculations independently of the new value.

Classification is independent of event date. The local reporting policy treats
this exact category separately from ordinary Codex allowance for event times
from `2026-10-06T00:00:00.000Z`, while retaining all tokens and API-price-equivalent
cost and preserving earlier events' former treatment. This is the accepted
local product policy, not provider-authoritative billing evidence.

The reduced value stays in existing local index and collector classification
fields. Safe export records omit `threadSource`, and hosted telemetry fields
and enums do not widen. Unified parser v20 reparses present sources; unavailable
historical sources preserve their facts and prior provenance. The legacy
archive parser advances to v7. Passive collector checkpoints re-read only a
bounded header to refresh the new category and keep their cursor, counters,
model, tier and replay state. A failed or absent metadata read never creates
the classification.

Schema, minimum reader and minimum writer versions advance from 11 to 12 as a
forward-only interpretation fence. No physical column is added: the existing
`surface_class.thread_source` TEXT column holds the closed value. The additive
transactional migration preserves all rows and tables; older applications must
refuse the newer database. This source contract does not establish a packaged
or installed release.

## Binary/version diagnostic

`usage-monitor doctor` reports the selected Codex binary source and the exact
version returned by that binary. The projection is path-free and closed to
`CODEX_BIN override`, `ChatGPT bundled`, `Codex bundled`, or `PATH`; malformed
output and execution failures become `version unavailable`. Selection uses the
same precedence as the app-server client, so installing a newer PATH CLI does
not falsely imply that TiboTattle selected it ahead of an embedded binary.

As of 2026-09-26, the diagnostic also reports a path-free bundle location:
system or user Applications, and the bundled `codex-cli/bin/codex` or legacy
`codex` layout. Discovery checks those two executable layouts in each official
ChatGPT or Codex app bundle. An explicit `CODEX_BIN` override remains first;
`PATH` remains the fallback for custom installations. This is source selection
evidence, not proof that app-server initialization or a quota read succeeds.

## Review trigger

Add a new mapping only when all of the following are available:

- the value is observed in persisted local metadata rather than only remote
  request headers;
- its lifecycle and billing meaning are documented or reproducibly verified;
- it maps to a stable low-cardinality product category; and
- privacy tests prove that the raw caller label is not retained or exported.
