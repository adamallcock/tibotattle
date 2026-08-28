# Codex provider guidance

Scope: all files under `src/providers/codex/`. Apply `AGENTS.md` and
`src/AGENTS.md` first.

## Source and normalization boundary

- Codex rollouts, archives, app-server messages, account state, and configuration
  are private, untrusted, and version-varying inputs. Parse defensively and never
  expose their content or absolute locations.
- Separate source discovery, bounded reading, parsing, normalization, account
  scope, quota normalization, plan/tier normalization, and surface classification.
  Do not make one stage guess evidence owned by another.
- Accept only complete records and supported shapes. A malformed, oversized,
  truncated, appended, rotated, moved, duplicated, or forked source must produce
  deterministic bounded behavior and must not corrupt the last committed cursor.
- Preserve exactly-once logical occurrence across retries and duplicate physical
  files while retaining enough privacy-safe lineage to detect a genuinely new
  event. Never use a display timestamp alone as identity.
- Treat `thread_source` and similar metadata according to their defined semantic
  scope. Attribution metadata does not establish billing surface, account scope,
  quota ownership, or causal usage.

## Evidence semantics

- Preserve unknown model, speed mode, service tier, plan, quota family, reset
  identity, freshness, and account attribution. Do not backfill earlier events
  from the current account or a later setting change.
- Keep ChatGPT subscription Fast mode distinct from API priority service tier.
  Pricing requires explicit billing-surface context.
- Rate-limit snapshots are observations with age and source, not authoritative
  allowance capacity. Integer percentages do not provide hidden precision.
- App-server quota refresh is read-only and must not create a model turn. Failure
  leaves the previous observation stale/unavailable rather than fabricating one.
- Errors, metrics, and fixtures remain content-free; hash or count safe categories
  rather than echoing provider fields.

## Validation

- Add focused parser fixtures for supported versions and negative fixtures for
  incomplete, malformed, duplicated, appended, rotated, and unknown input.
- Use synthetic records that preserve structure without real prompts, paths,
  account data, or rollout identifiers.
- Run affected provider, ingestion, collector, and unified-index tests, then
  `npm run architecture:check` and the applicable root/local gate.
- Re-test replay and attribution whenever source keys, cursors, occurrence IDs,
  account markers, or normalization fields change.
- A parser test passing on one captured version is not cross-version or live
  qualification; document the supported shape and unknown fallback.
