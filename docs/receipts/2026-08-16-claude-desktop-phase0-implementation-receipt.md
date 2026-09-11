---
title: Claude Desktop Phase 0 Preparation Implementation Receipt
date: 2026-08-16
type: receipt
status: historical-evidence
---

# Claude Desktop Phase 0 preparation implementation receipt

> **Point-in-time evidence, not current product behavior.** PR #78 later
> removed the shipping Claude plan-history refresh, quota-state store, and
> `/api/local/claude/quota` route recorded below. The separately installed
> managed Claude callback and hard-disabled qualification seam have different
> boundaries. Use the maintained architecture and privacy references for the
> installed app.

## Implemented

- Privacy-safe, hash-manifested Desktop metadata, transcript, quota, retention, and
  ledger fixtures under `test/fixtures/claude-desktop-phase0/`.
- Read-only hierarchical Desktop inventory with local-surface selection, exact parent
  matching, bounded child traversal, orphan/unselected classification, cleanup-marker
  race detection, entry limits, and a content-free public projection.
- Effective `cleanupPeriodDays` detection across managed, command-line, local,
  project, user, custom-config-root, and default scopes. It emits no unrelated setting
  values and provides guidance only; it does not edit Claude configuration.
- Exact version-2 native quota parsing with bounded file reads, keyed account scope,
  reviewed meters, keyed unknown-meter containment, nullable reset evidence, and
  correction revisions.
- Separate owner-only native quota state/refresh in the production local companion and
  a closed, snapshot-independent `/api/local/claude/quota` route; no installed macOS UI
  consumes it yet.
- Provider-isolated durable-ledger lifecycle prototype and explicit combined-output
  projection rule.
- Strict Claude pricing adapter plus prototype persistence, a streaming bounded
  pricing summary, and a separate replay-safe summary cache. A programmatic,
  disabled-by-default internal production refresh call site now exists; no route,
  response field, setting, upload, or installed-app consumer exists.
- Selected Desktop parent/child benchmark covering discovery, canonicalization, scan,
  quota parse, merge, projection, unchanged refresh, SQLite growth, and process RSS.
- Optional transcript source selection in the existing frozen Claude exporter plan;
  ordinary callers retain the prior all-source behavior.
- Strict selective transcript-row parsing: the complete JSON row is validated, but
  prompt, response, thinking, tool-input, and unrelated fields are never materialized.
- Content-free frozen-plan serialization and reconstruction against a fresh matching
  private source inventory.
- Bounded candidate-to-SQLite batches with atomic byte/line/cost cursor checkpoints,
  cursor-regression rejection, and forced-restart recovery.
- Reused FileHandle scratch buffers and SQLite statements on the hot path.

## Fixture and focused validation

The focused command was:

```text
node --test --test-concurrency=1 \
  test/bounded-jsonl-reader.test.js \
  test/claude-desktop-phase0-discovery.test.js \
  test/claude-desktop-phase0-ledger.test.js \
  test/claude-desktop-incremental-canonicalizer.test.js \
  test/claude-transcript-export-source.test.js \
  test/claude-transcript-workspace-source.test.js \
  test/export-source-pipeline-owner-boundary.test.js \
  test/r7-worker-watchdog.test.js
```

Final focused result: 82 passed, 0 failed, 0 skipped. The focused set includes
selective parsing, reader-boundary, frozen-plan, atomic-checkpoint, and forced-restart
tests, plus incremental restart/generation and isolated-worker watchdog coverage. The fixture
manifest independently hashes all four source fixture files and checks that they contain
no user path, private-canary prefix, or API-key prefix.

## Current-corpus benchmark

The live run used the owner-local Desktop metadata, selected transcript hierarchy,
cleanup marker, and native plan history. It persisted only a temporary content-free
ledger, emitted this numeric receipt, and removed the temporary directory on completion.

| Measurement | Result |
|---|---:|
| Interval | 2026-07-18T02:09:18.084Z to 2026-08-17T02:09:18.084Z |
| Metadata files | 97 |
| Selected parents | 68 |
| Missing parents | 27 |
| Selected children | 1,752 |
| New orphan transcripts | 1 |
| Selected source files | 1,820 |
| Frozen source bytes | 1,570,371,007 |
| Logical messages | 43,563 |
| Usage candidates | 43,580 |
| Native quota samples | 6,351 |
| Native quota observations | 13,273 |
| Inventory | 329.582 ms |
| Canonicalization | 13,836.959 ms |
| Candidate scan plus bounded merge | 13,957.314 ms |
| Usage merge work inside scan | 6,556.909 ms |
| Forced ledger restarts | 1; exact cursor resume, no duplicate candidates |
| Quota parse | 169.418 ms |
| Quota merge | 32.572 ms |
| Projection | 200.736 ms |
| Checkpoint/preparsed-quota replay lane | 32.318 ms; zero candidate reads and zero new rows |
| Content-free checkpoint bytes | 18,770,474 |
| SQLite bytes | 47,431,680 |
| Peak process RSS | 517,439,488 bytes |

The benchmark initially exposed accidental quadratic plan validation in its own
per-source loop. The final receipt uses the existing bulk frozen-plan slicer, which
validates the full plan once. Two aborted benchmark temporary directories were moved to
Trash and are recoverable; no source files were changed.

## Previous global-plan verdict

Correctness, privacy-minimized parsing, bounded merge, and restart resume: **pass**.

This verdict applied to the superseded frozen-global-plan implementation:
changed-transcript background-refresh suitability was **fail**. Peak RSS fell by about
73%, and the narrow checkpoint replay lane is fast, but the approximately 29-second
initial/global path remains too expensive for a menu-bar refresh. More importantly,
the 32.318-ms number excludes fresh inventory, quota parsing, and changed-plan
canonicalization; it must not be presented as end-to-end refresh latency. Any transcript
append still rebuilds the global canonical plan. No public or production-support claim
should follow from this prototype. The next gate is durable incremental canonical state
across plan generations plus separate first-import, one-row-append, and truly-unchanged
end-to-end receipts under an isolated-worker RSS ceiling.

## Incremental canonicalization follow-on

The next pass removed the global-plan replay from normal refreshes. It adds:

- a content-free canonical SQLite store with keyed source/message/tool identities,
  exact existing-exporter winner and candidate semantics, source generations, dirty
  groups, and prefix byte/line/hash cursors;
- append-only suffix parsing with prior-prefix verification;
- zero-byte unchanged-source handling across database/process restart;
- owner-only main/WAL/SHM files, database secret binding, and monotonic/expandable
  capture-window state;
- atomic dirty-group acknowledgement only after projection, pricing-cache, and shadow
  publication succeed, so downstream failure leaves the group replayable;
- privacy assertions over the database and sidecars;
- exact candidate parity against the frozen exporter;
- generation-bound immutable ledger candidate keys after a source rebuild, with
  aggregate source-byte and canonical-record limits; and
- short-lived initial/refresh workers enforced by the existing Darwin-arm64 RSS
  watchdog, including the worker lifetime high-water measurement.

### Isolated current-corpus receipt

| Measurement | First import | Fully unchanged refresh |
|---|---:|---:|
| End-to-end elapsed | 36,327.816 ms | 763.630 ms |
| Inventory | 363.556 ms | 333.974 ms |
| Incremental canonicalization | 32,601.118 ms | 250.320 ms |
| Parsed transcript bytes | 1,570,371,007 | 0 |
| Parsed transcript lines | 298,156 | 0 |
| Assistant occurrences inspected | 152,792 | 0 |
| Canonical groups | 57,538 | 57,538 retained |
| Usage candidates merged | 43,580 | 0 |
| Quota parse | 152.139 ms | 154.949 ms |
| Quota merge | 31.630 ms | 19.744 ms; 13,273 duplicates |
| Projection | 193.154 ms; generation 1 | Not republished |
| Worker lifetime peak RSS | 534,249,472 bytes | 202,817,536 bytes |
| Watchdog ceiling | 768 MiB | 256 MiB |
| RSS samples/failures | 359 / 0 | 10 / 0 |

The combined canonical and provider-ledger footprint was 333,643,776 bytes. The
background unchanged path now passes its explicit time/RSS gate. The first import is a
foreground/bootstrap operation and still needs product progress/cancellation UX.

### Append boundary

The one-row append fixture passes across restart with exactly one parsed suffix line,
one dirty logical group, exact candidate parity with the frozen exporter, unioned tool
counts, and no duplicate winner. Same-file prefix mutation fails closed and source
disappearance leaves accepted groups intact.

The implementation parses only the suffix but rehashes the changed file's accepted
and current complete prefixes. A generated-corpus scale receipt is recorded below;
private real-history mutation remains unmeasured because we did not alter or copy
private real transcripts solely to manufacture this benchmark. The production-shaped
synthetic p99-size lifecycle passes the 768-MiB bootstrap and 256-MiB background
ceilings after both pricing and ordinary usage projection are streamed. A read-only
aggregate density/composition tool now exists and has a successful real-corpus density
receipt; the representative shadow-database compaction decision remains open alongside
production/installed-app gates.

### Privacy-safe synthetic scaled-append receipt — 2026-08-17

The append gate has a deterministic generated-corpus receipt. It creates
one owner-only synthetic JSONL source in a temporary directory and emits aggregate
counts/timings/bytes/RSS only; no private transcript, source path, identifier, model
string, or transcript content is read or retained. The scale knob is the generated
initial line count, so this receipt does not change or copy the owner's real history.

The focused test is:

```text
node --test --test-concurrency=1 test/claude-desktop-synthetic-append-benchmark.test.js
```

Result: 1 passed, 0 failed, 0 skipped. The initial 5,000-line run exercised the
row-rich debug pricing projection and peaked at 497,942,528 bytes. Follow-up runs at
10,000 lines exceeded 768 MiB, and a 35,000-line run exceeded 1.5 GB. That was a real
failure: aggregate-only worker output did not help because the debug projection had
already materialized every priced row and its whole-payload digest.

The benchmark was then wired to the bounded streaming pricing summary and replay-safe
summary cache, and ordinary usage projection was changed to stream the exact legacy
array digest—the intended background/shadow lane. A 35,000-line, 15,470,000-byte run
under a 768-MiB ceiling completed all five lifecycle phases:

| Phase | Elapsed | Parsed lines | Parsed bytes | Source action | Candidates | Peak RSS |
|---|---:|---:|---:|---|---:|---:|
| First import | 11,805.106 ms | 35,000 | 15,470,000 | rebuild | 35,000 | 325,959,680 bytes |
| Unchanged | 1,524.025 ms | 0 | 0 | unchanged | 0 | 142,508,032 bytes |
| One-row append | 1,799.832 ms | 1 | 442 | append | 1 | 145,948,672 bytes |
| Restart after append | 1,809.663 ms | 0 | 0 | unchanged | 0 | 143,228,928 bytes |
| Same-size prefix mutation | 9,834.511 ms | 35,001 | 15,470,442 | rebuild | 1 | 152,289,280 bytes |

The generated source was 15,470,000 bytes initially and 15,470,442 bytes after the
one-row append. The mutation changed exactly one content byte while changing source
length by zero bytes; it rebuilt the source and superseded exactly one winner. All five
content-free lifecycle invariants passed. Pricing-cache publications were `published`,
`reused`, `published`, `reused`, and `published`, proving exact replay and append/
correction invalidation on the measured path. The locally observed selected-source size
distribution placed 15.3 MB around p99, but bytes are not a full proxy for assistant
candidate density. This closes the synthetic p99-size bootstrap/background budget,
not the maximum-source or whole-corpus production gates.

## Native quota and pricing follow-on — 2026-08-17

The native quota track now reaches the production local-companion backend boundary:

- `plan-usage-history.json` is the only accepted source, under the exact Claude
  Application Support directory; transcript paths are not an input;
- a separate owner-only SQLite state file and stable owner-only HMAC secret retain
  durable revisions without storing raw account identifiers or source paths;
- quota refresh runs concurrently and independently from Codex refresh, with contained
  errors and abort settlement;
- `/api/local/claude/quota` is a GET-only, snapshot-independent projection boundary;
- the public result admits only reviewed meter identities and asserts that it contains
  no content, paths, or identifiers; and
- exact replay, correction reversion, rolling empty/shorter snapshots, unknown-only
  accounts, large bounded inputs, malformed input, missing input, and already-aborted
  refreshes have focused regression coverage.

The state binds itself to one HMAC-derived source namespace and fails closed if the
secret changes while the database remains. Public windows, durable counts, and coverage
gaps are scoped to the selected source. A known-account snapshot replaced by unknown-only
data is partial/stale with no displayed windows. By contrast, a normal bounded-history
shift whose reviewed meters and newest timestamp advance remains current; treating every
discarded oldest row as a gap would make a healthy rolling source perpetually partial.

The current snapshot is replaced transactionally while durable quota revisions remain
available for lifecycle evidence. Consequently, a rolling file that becomes empty or
loses a meter cannot keep presenting an earlier window as current. The source is marked
partial/stale, disappeared windows are omitted, and the last successful complete
observation time is not advanced.

A live, read-only two-pass smoke against the real owner-local native quota file used a
temporary state directory and then removed it. File permissions were `0700` for the
Claude directory and `0600` for the source file. The first pass completed in 318 ms and
inserted 13,139 observations; the second completed in 220 ms with zero inserts and
13,139 duplicates. The projection was available with three reviewed windows and no
unknown meters, paths, content, or identifiers. The source file was not changed.

The pricing track now has a strict adapter, standalone prototype persistence, a
coverage-qualified debug projection, and a bounded streaming summary. The durable
prototype preserves canonical event time,
validated model declaration, Claude subscription billing surface, total input,
cache-read/cache-write TTL components, and `provider_reported_combined` output
provenance. Legacy standalone rows migrate additively and remain visibly unpriced when
the required evidence is absent. An empty projection is `unpriced`, not a fully priced
zero. Its payload digest changes on winner correction even when the ordinary usage
projection generation remains unchanged. A separate owner-only cache now persists only
the bounded summary: event count, total, coverage counts/status, warning codes, ordered
pricing digest, and payload digest. Exact replay reuses its publication generation; a
corrected winner invalidates it; failed publication retains the last-good summary.

These are deliberately different production boundaries. Quota has local-companion
state and an API route, but no installed macOS menu-bar consumer. Pricing has a
production-shaped replay-safe summary cache behind an explicit opt-in path, but no
an internal production server call site only behind a programmatic shadow opt-in, and
no installed consumer. Neither change requires a broad provider-column migration of
the Codex tables.

## Production-shaped disabled shadow preparation — 2026-08-17

The repository now contains a separate Claude shadow controller and provenance
namespace. The real local-companion refresh runner can invoke it only through an
explicit programmatic opt-in. Disabled mode creates no file, and there is no
environment switch, route, response field, setting, UI, or upload behavior. Enabled
mode is owner-only and local-only, rejects Codex provider values, and accepts only the
closed minimized Claude usage-candidate shape. Unknown/private fields are rejected
before hashing; quota parsing is disabled because the native quota state already owns
that history. Durable shadow rows contain only keyed record/artifact digests and
lifecycle metadata, not transcript content, paths, raw identifiers, pricing rows, or
arbitrary labels.

The controller uses a 30-day bounded capture window, cooperative cancellation,
timeout, serialization, and exponential backoff. Its result projection contains only
fixed enums, aggregate counts, and timings. A missing quota file does not block
usage-ready partial readiness. Caller/deadline cancellation now covers readiness and
secret setup; a non-cooperative read-only readiness probe is bounded by the controller
deadline rather than holding the refresh open.

The shadow purge coordinator writes a durable provider-ledger tombstone and shadow
receipt before touching explicitly enumerated physical artifacts. It deliberately
retains the Claude ledger: deleting that tombstone authority would allow still-present
raw files to resurrect a purged interval. It removes only rebuildable canonical and
pricing-cache files plus their named WAL/SHM/journal sidecars; traversal,
sibling-prefix escape, symlink, non-owner, and live control-database targets fail
closed. Both durable stores and the complete physical inventory are preflighted before
the ledger is mutated. Partial-range purges split intersecting coverage gaps at exact
millisecond boundaries and preserve surviving winner revision provenance. Bounded
purges invalidate whole-generation derived shadow artifacts and block re-import of
deleted event ranges. It intentionally does not glob or infer files.

A content-free readiness projection checks only the allowlisted Desktop session,
Claude projects, and native quota locations plus the minimized effective-retention
projection. On the current Mac it reported usage metadata, projects, quota, and the
30-day default retention as available while shadow mode remained disabled. It returns
no path, filename, source identifier, setting body, transcript content, or account
identity. These components are wired only as a disabled internal local-companion
shadow. They are not wired to app settings, dashboard, upload pipeline, installed UI,
or a public support claim.

The dormant production call site resolves a custom `CLAUDE_CONFIG_DIR` and an
explicit/current Claude project independently from installed application resources.
Disabled mode does not validate malformed provider path variables, so a bad Claude
configuration cannot prevent the ordinary Codex companion from starting. A no-listen
server wiring regression covers both states, and no environment variable can enable
shadow collection.

## Debug containment, closed contracts, and adversarial refresh matrix — 2026-08-17

The production-shaped incremental entrypoint now exposes the row-rich pricing
projection only as a debug opt-in capped at 5,000 winners. Ordinary and shadow
refreshes use the streaming bounded summary. Requests above the cap fail before row
materialization and before a pricing-cache file can be created. The lower-level
prototype ledger reader remains a direct developer API and is not a production call
site.

The closed accounting contract freezes capture-start and gap semantics, distinguishes
provider cleanup from explicit user purge, and requires cleanup-marker or provider-
runtime evidence before a missing source can be labelled provider cleanup. It
represents missing account attribution, reports 30-day/default, configured-90-day, or
unknown source horizons without claiming to restore deleted history, and makes pricing
coverage fail closed, including the pricing adapter's invalid-input state. Its display
compatibility view is explicitly `text = combined`, `reasoning = 0`, with reasoning
provenance `not_reported_by_provider`; it is not a new token fact.

The read-only density/composition tool emits aggregate candidate-count percentiles,
bytes-per-candidate, fixed reviewed SQLite component/page totals, and one folded
unreviewed bucket. It never returns paths, source/account/session identities, model
strings, or content, and it creates no canonicalizer, ledger, cache, checkpoint, or
parsed-text artifact. The first 120-second and 5-minute runs correctly failed closed
on elapsed time because the initial implementation accidentally revalidated the entire
1,000-plus-source plan for every source. Reusing the existing one-time bulk plan slice
removed that quadratic work. The successful current-corpus receipt is:

| Measurement | Result |
|---|---:|
| Inventory JSONL files | 1,476 |
| Selected source files | 1,471 |
| Selected source bytes | 1,377,321,447 |
| Candidate count | 43,812 |
| Sources with candidates | 914 |
| Zero-candidate selected sources | 557 |
| Candidates/source p50 / p90 / p95 / p99 / max | 8 / 65 / 108.5 / 258.9 / 5,371 |
| Aggregate bytes/candidate | 31,437.08 |
| Per-source bytes/candidate p50 / p90 / p95 / p99 / max | 16,214.61 / 38,441.08 / 65,685.45 / 395,358.85 / 22,092,648.67 |

The receipt was aggregate-only and created no durable artifacts. SQLite component
measurement is implemented and tested with a fixed reviewed-label allowlist and a
folded unreviewed bucket. It opens SQLite through an immutable URI so even a WAL-backed
database with a missing `-shm` sidecar cannot create one; component pages describe the
immutable main database, while WAL/SHM byte sizes are reported separately and
uncheckpointed WAL pages are explicitly excluded. No representative production shadow
database exists yet because that lane remains disabled by default.

The focused adversarial matrix now covers disabled/no-write behavior, usage-ready
partial readiness without quota, blocked sources, fixed failure receipts and backoff,
busy refusal, caller cancellation, source disappearance, usage-only quota separation,
downstream shadow failure followed by idempotent replay, mixed-provider rejection,
raw path/content/model canaries, parser-legacy unpriced behavior, and purge followed by
raw-source re-import attempts. Explicit purge retains both ledger and shadow
tombstones, while rebuildable canonical/pricing files are removed.

## Repository validation boundary

- Focused Claude/Phase 0/shared-reader/watchdog suite: 82 passed, 0 failed, 0 skipped.
- Final change-focused accounting/density/canonicalization/ledger/shadow/local-refresh
  closure suite: 108 passed, 0 failed, 0 skipped. The dormant production wiring's two
  custom-root/disabled-path regressions also passed without opening a listener.
- The complete `test/claude-desktop-*.test.js` set passed 102/102 outside the restricted
  network sandbox, including all four loopback quota-route cases.
- The complete local-product suite passed 196/196 outside the restricted network
  sandbox after the closed health-capability expectation was updated for
  `claudeDesktopQuota`.
- Expanded adjacent boundary suite: 78 passed and 1 failed. The failure is an existing
  exact platform-export inventory mismatch for unrelated contribution-device reader
  symbols; all Claude, bounded-reader, resource-policy, and Codex-provider assertions
  passed.
- The internal Claude incremental benchmark worker is classified. The clean source-only
  branch's inventory gate passed with 59 records, 61 executable paths, and 52 aliases.
- Architecture boundary check: passed with 355 production files, 1,370 imports, and no
  approved debt edges.
- The reviewed client exporter allow-list now closes over the dormant Claude local-server
  imports. Its artifact and no-clobber tests passed 2/2; no client artifact was published.
- Repository documentation-link maintenance passed: documentation links are normalized.
- The authoritative full `npm test` run outside the restricted sandbox completed with
  2,313 tests: 2,300 passed, 9 failed, and 4 skipped. A detached `origin/main`
  comparison reproduced every remaining failure: two stale export public-API lists,
  one stale platform public-API list, one quota-kernel hash and one shared-quota behavior
  assertion, two retained R7 workload-provenance receipts, and two synthetic R7
  lifecycle-determinism checks. The Claude branch added no failing test after the client
  exporter closure was repaired. The retained R7 receipts were not regenerated because
  dual-runtime client-release qualification is a separate release gate.
- The source-only extraction was based on the current `0.1.12` source, did not bump the
  client version, and did not deploy a client, Worker, or public support surface.
