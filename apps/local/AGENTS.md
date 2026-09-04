# Local companion and unified-index guidance

Scope: all files under `apps/local/` and the local companion behavior they
compose. Apply the repository root guidance first.

## Ownership and trust boundary

- The companion and unified local index are the sole parsing, accounting, and
  local-reporting authority. Browser and native shells consume validated routes;
  they must not grow competing parsers, ledgers, or source scanners.
- Bind to loopback only. Validate host, origin, method, content type, body size,
  and request capability before work. Never broaden CORS or accept an arbitrary
  local-network origin for convenience.
- Treat every local source file, provider response, cached artifact, and query as
  untrusted input. Errors and diagnostics remain bounded and content-free.
- The local product must remain useful offline. Hosted health, auth, and
  contribution are optional capabilities with explicit unavailable states.

## State and indexing

- SQLite `application_id`, schema version, append-only enums, migrations, and
  published generations are compatibility contracts. Change them together with
  validation, migration, refusal, rollback, and recovery tests.
- A staged or incomplete generation is not live. Publish a complete validated
  generation atomically; preserve the previous good generation on cancellation,
  failure, crash, or incompatible provenance.
- Never open incompatible state by changing metadata, skipping validation, or
  deleting the database. Preserve the original and rehearse forward recovery
  against a copy.
- Ingestion is incremental, bounded, and exactly-once across retries, file growth,
  truncation, aliases, forks, and process restarts. Persist privacy-safe lineage
  needed to prove replay behavior, never raw source paths or session content.
- Treat cache freshness, indexed coverage, account attribution, and all-history
  completion as separate dimensions. A cached display window is not retention
  and does not authorize deleting older evidence.
- Long work is cancellable and resumable. Keep control-plane routes responsive
  while indexing and expose honest progress without inventing completion times.

## API and presentation semantics

- Keep quota refresh, accounting refresh, index maintenance, and contribution
  sync independently observable. One successful subsystem must not mask another
  failure.
- Return explicit unknown, stale, partial, unavailable, cancelled, and failed
  states. Preserve a last-good value only with its source and freshness label.
- Use same-origin opaque capabilities for privileged loopback actions and bind
  them to one operation and lifecycle. Do not place credentials or private state
  in URLs, browser storage, or rendered diagnostics.
- Contribution routes may consume only prepared, privacy-validated data and
  must preserve versioned authorization, durable opt-out, legacy review/consent,
  retry and deletion guarantees.
- Do not relay retired participant deletion or private owner-erasure requests.
  Device disconnect revokes this Mac's authority and preserves hosted/local
  history; browser sign-out and local identity reset are different operations.
- Persist disconnect intent as `device_disconnected` before revocation or
  credential cleanup. Preserve consent and measured progress/history, keep the
  pause across restart, and require explicit approval or resume to rearm sync.

## Validation

- Run the narrow `apps/local/*.test.mjs` or affected root tests while iterating.
- Run `npm run product:local:test` for companion, refresh, contribution, or route
  changes; add `npm run product:ui:test` when browser contracts change.
- Exercise an actual loopback server for route, origin, cancellation, and
  progress changes. Use isolated synthetic state, not the user's live index.
- Add restart and incompatible-state coverage for schema, generation, cache, or
  ingestion changes. A successful clean build alone is insufficient.
- Native consumers require their own macOS validation; local browser success does
  not qualify an embedded or installed native surface.
