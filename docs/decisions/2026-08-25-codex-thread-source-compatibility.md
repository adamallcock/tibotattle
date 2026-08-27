---
title: Codex thread-source compatibility and binary diagnostics
date: 2026-08-25
type: decision-record
status: implemented
---

# Codex thread-source compatibility and binary diagnostics

## Decision

Codex `session_meta.payload.thread_source` remains an input to TiboTattle's
fixed, privacy-safe classification, not a field whose raw value crosses into
local projections or contribution records. Reviewed values map to `user`,
`subagent`, or `automation`; absent, malformed, and unreviewed feature labels
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
source deduplication. Missing a new label therefore creates attribution drift:
automated or system work can accumulate under `unknown` or a generic local/CLI
surface. It does not drop usage or change its API-price equivalent. A guessed
mapping would be worse because it could make the same usage confidently appear
under the wrong surface.

## Binary/version diagnostic

`usage-monitor doctor` reports the selected Codex binary source and the exact
version returned by that binary. The projection is path-free and closed to
`CODEX_BIN override`, `ChatGPT bundled`, `Codex bundled`, or `PATH`; malformed
output and execution failures become `version unavailable`. Selection uses the
same precedence as the app-server client, so installing a newer PATH CLI does
not falsely imply that TiboTattle selected it ahead of an embedded binary.

## Review trigger

Add a new mapping only when all of the following are available:

- the value is observed in persisted local metadata rather than only remote
  request headers;
- its lifecycle and billing meaning are documented or reproducibly verified;
- it maps to a stable low-cardinality product category; and
- privacy tests prove that the raw caller label is not retained or exported.
