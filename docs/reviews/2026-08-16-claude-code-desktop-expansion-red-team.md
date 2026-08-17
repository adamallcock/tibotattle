---
title: Claude Code Desktop Expansion Red-Team Review
date: 2026-08-16
type: review
status: phase-0-only; architecture revised
reviewers:
  - local-retention-forensics
  - official-source-research
  - competitive-source-research
  - repository-architecture-review
---

# Verdict

**Proceed to Phase 0: yes.**

**Proceed directly to the original beta build: no.** The plan's token grammar and
pricing reuse are sound, but its retention architecture was not. Claude's default
30-day local transcript-cache cleanup is a hard *exact per-event backfill* boundary
for the verified passive consumer source, not a switch to a second canonical archive.
TiboTattle must preserve accepted
facts in its own durable ledger before Claude removes the source and must show any
unobserved interval as a gap, never as zero.

The product therefore has two adoption states, not two accounting products:

1. **Source still available:** import every metadata-selected transcript that is
   still present, regardless of its age, then reconcile future changes into the
   TiboTattle ledger.
2. **Source already unavailable:** retain metadata-only evidence of activity and
   mark token history unavailable. Exact local token totals cannot be recovered
   after cleanup unless TiboTattle captured them earlier.

Anthropic's documented OpenTelemetry surface is a credible optional, forward-only
continuity adapter. It is not historical backfill, quota/reset truth, or guaranteed
delivery. It belongs behind a separate exact-build smoke, privacy review, and
explicit opt-in after the transcript/native-history beta architecture is correct.

# What the review changed

| Original assumption | Red-team result | Required decision |
|---|---|---|
| “Inside 30 days” and “after 30 days” are two source paths | Cleanup is based on top-level transcript file `mtime`, is configurable, and removes its sibling session directory; child age is not the boundary | Branch on source/capture state, not record age |
| A staged Claude provider-slice rebuild is a safe simple option | Replacing a provider slice after source cleanup can erase facts that Tibo previously accepted | Append/merge into a durable ledger; rebuild only derived projections |
| Top-level transcript inventory is the corpus | 68 matched desktop parents own 1,747 nested subagent transcripts; one nested transcript is orphaned | Inventory parent plus proven children; retain unresolved orphans without blind inclusion |
| Existing coverage counts are sufficient | First-install, provider-cleaned, inaccessible, remote, collector-down, parser-legacy, and user-purged are materially different | Persist interval-based coverage and source lifecycle state |
| OTel could be an “after 30 days” source | OTel begins only after configuration, its delivery durability is unspecified, it can include non-user-facing calls, and it has no quota resets | Optional live adapter into the same ledger, never retrospective recovery |
| Longer retention is an implementation detail | Tibo retaining usage after Claude deletes raw transcripts changes the privacy promise | Explicit local retention explanation, setting, purge control, and purge receipt |
| Tibo should silently extend Claude's 30-day cleanup | Longer Claude retention improves the recovery window but keeps sensitive plaintext transcripts and related application data longer | Keep 30 fully supported; offer guided 90-day opt-in with explicit privacy copy and no automatic edit in the first beta |

# Critical findings

## P0-1 — No exact passive per-session reconstruction was verified after cleanup

Anthropic documents a default **local transcript-cache cleanup horizon** of 30 days
and a configurable `cleanupPeriodDays` with a one-day minimum in
[Claude directory configuration](https://code.claude.com/docs/en/claude-directory).
Inspection of the installed `2.1.229` runtime confirmed that the sweep evaluates
top-level transcript file modification time and, when deleting the parent JSONL,
recursively removes its sibling session directory.

On this Mac, 27 desktop metadata records with a `cliSessionId` no longer had a
matching top-level transcript; all 27 had activity timestamps older than 30 days. No
matching per-session source was found in the inspected roots. Aggregate/cached
artifacts such as `stats-cache.json` or `usage-data/` may remain, but have not been
verified as canonical event reconstruction. Desktop metadata and app logs can
establish that a task existed, but not its exact tokens.

Required product claim:

> TiboTattle can preserve exact Claude event history from the point it starts
> observing it. It cannot reconstruct exact per-session events that Claude has already
> deleted; separately reviewed aggregate caches, when present, remain aggregate-only.

The Enterprise Compliance API is a separate authenticated organization product,
not a consumer fallback. Its session-transcript endpoint is a Claude Enterprise beta
requiring a Compliance Access Key with `read:compliance_user_data`; Admin API keys
cannot use it, and local capture requires Enterprise sign-in. The documented
session/activity surface does not document plan quota percentage or reset meters. If
ever added, treat it as a separate enterprise connector and permission boundary. See
[Compliance API overview](https://platform.claude.com/docs/en/manage-claude/compliance-api)
and [Compliance sessions](https://platform.claude.com/docs/en/manage-claude/compliance-sessions).

## P0-2 — Source disappearance must never delete accepted facts

The repository contains two relevant patterns. The current incremental unified
index deliberately leaves rows whose rollout source has rotated away untouched.
However, the archive/local-analysis refresh path removes sources absent from the
latest discovery and cascades deletion to their facts. A fresh staged database can
also publish a valid-looking but shorter provider history after Claude cleanup.

For Claude, source absence must become a lifecycle observation such as
`missing_suspected`, evidence-backed `expired`, or `inaccessible`. It must not delete
facts. Only an explicit Tibo user purge or a previously selected automatic-retention
policy may remove retained Claude history; neither deletes Claude's raw files.
Publication must assert
that all previously accepted event and quota identities remain present except for
explicitly purged identities.

The implementation must use a new non-cascading provider-aware ledger, or first
migrate the current `local-analysis-index` foreign keys and refresh deletion into
lifecycle tombstones. Its existing source-delete cascade cannot be reused as the
Claude durable layer. The acceptance test must traverse the actual production refresh
path, not only a prototype database.

## P0-3 — The durable layer and the derived cache must be separate

Use an append/merge ledger for source evidence and rebuildable provider-specific
projections for charts, pricing, and summaries:

```text
Claude sources -> verified candidates -> logical winner ledger -> projections
                         |                       |                  |
                         + source lifecycle      + immutable IDs    + replaceable
```

The ledger must survive source cleanup, incomplete discovery, app restart, price
changes, and failed projection rebuilds. A projection publish records its ledger
high-water mark and retains the prior generation on failure. A provider-only rebuild
must not replace the other provider's facts or accounting cache.

Cross-source identity needs keyed forms of provider/transcript request ID,
client-request ID, message UUID/ID, session ID, and iteration/attempt ordinal. One
transcript message can represent multiple requests. Reconciliation is field-level:
OTel may improve live request identity while transcripts retain richer cache-TTL and
user-facing semantics; never let a sparse OTel row overwrite richer transcript fields.

## P0-4 — The source inventory is hierarchical

The current corpus contains 73 top-level transcript JSONL files and 1,748 nested
subagent JSONL files. Sixty-eight metadata-matched desktop parents own 1,747 of the
nested files; one nested file is orphaned. Many children are older than 30 days even
though their top-level parent remains current. The earlier appearance of hundreds of
“expired but present” files was therefore a classification error.

Inventory rules must be:

- metadata selects a top-level Code session;
- that selected parent authorizes traversal of its bounded sibling session tree;
- record timestamps determine accounting time;
- top-level source `mtime` and cleanup markers are lifecycle/change evidence only;
- a missing parent does not cascade-delete previously accepted child facts; and
- an orphan is retained as unresolved evidence only if previously known, not blindly
  admitted as a new Code session.

## P0-5 — Coverage is a first-class stored fact

The dashboard cannot infer completeness from the number of indexed files. Persist:

- adoption and first-successful-capture timestamps;
- provider, account, and surface;
- source lifecycle and last successful scan;
- interval, reason, confidence, and evidence generation for each known gap; and
- parser state for retained rows whose source is no longer available for reparse.

At minimum distinguish `pre_install`, `expired_by_provider`, `inaccessible`,
`missing_suspected`, `cleanup_paused`, `config_changed`, `manual_missing`,
`aggregate_only`, `remote_unavailable`, `collector_unavailable`, `parser_legacy`,
`lineage_unresolved`, and `user_purged`. Missing alone does not prove provider cleanup;
gap bounds come from adjacent successful scans with stated confidence. Aggregate
caches such as `stats-cache.json`/`usage-data/` never enter per-event winners. Missing
history is “unavailable,” not a zero bucket.

## P0-6 — Tibo's longer retention needs explicit consent and deletion semantics

Once TiboTattle retains derived facts beyond Claude's cleanup, its database becomes
the longer-lived record. Do not retain raw Claude session IDs, paths, prompts,
responses, tool inputs, or account identifiers in any table, legacy identity path,
cache, sidecar, backup, log, diagnostic, UI payload, or error. Explain local retention
in product copy. Provider/period deletion must split/recompute source lifecycle,
winner revisions, coverage, manifests, and keyed lineage; invalidate caches,
WAL/SHM/journals/backups; retain only an approved content-free receipt; and affect
neither Codex nor Claude's raw files.

Because Claude's raw source may still exist, a purge or configured automatic expiry
also needs a provider/source-generation/time-range tombstone (or explicit capture-
disabled state). The next scan must not resurrect purged history. The product must say
when post-purge capture can resume.

Claude's own `cleanupPeriodDays` is a different control. Detect only its effective
value/scope and discard unrelated settings. A 90-day value can be offered as guided,
explicit opt-in for resilience, but 30 days remains the privacy-first, fully supported
default. The extension cannot restore deleted files, does not change Anthropic server
retention, and retains sensitive plaintext transcripts plus related application data
for longer. The first beta must not silently or automatically edit Claude settings.

# OTel red-team

Anthropic now officially documents Claude Code OTel and says Desktop Code-tab events
use `service.name=claude-code-desktop`. The request event can contain scalar input,
output, cache-read/cache-creation, model, estimated cost, request identifiers, and
query source. See
[Monitoring Claude Code usage](https://code.claude.com/docs/en/monitoring-usage).

That makes OTel worth a bounded spike, with these constraints:

- It is **forward-only** from explicit configuration and verified receipt.
- Use request-level `claude_code.api_request` logs as the event lane, not aggregated
  metrics as the canonical ledger.
- Anthropic's public contract does not specify OTLP durability, replay, offline
  queuing, or shutdown flushing. Treat process/collector-outage delivery as unverified,
  fault-test it, and record any affected interval as a gap. Transcript reconciliation
  remains the fallback while source files survive.
- OTel API totals may include auxiliary or internal calls that are not equivalent to
  user-facing transcript totals. Preserve `api_total` and `user_facing_total` as
  distinct policies until identity reconciliation proves equivalence.
- `request_id` may be absent, `client_request_id` is conditional, and event sequence is
  session-local. Store an ingest identity and canonical payload hash, grade identity
  strength, and surface conflicts instead of summing them.
- Treat runtime `>=2.1.214` only as the minimum containing the known fix/client-ID
  support; Anthropic's
  [changelog](https://code.claude.com/docs/en/changelog) records a fix for token/cost
  double counting on cumulative streaming frames at that version. Exact-build delivery,
  privacy, and reconciliation tests remain mandatory.
- Do not add `subagent_completed.total_tokens` to request events; it is not a second
  independent total.
- OTel supplies no plan quota percentage or reset schedule. The native quota-history
  lane remains separate.

The receiver must be explicit and reversible, pin HTTP/protobuf or gRPC plus its
signal-specific loopback path, and apply strict body/rate limits. Accept the OTLP
envelope, discard unneeded records individually, durably commit accepted request
records before ACK, and fail only malformed/uncommitted batches. Expose content-free
dropped/unknown counts without payload logs. Allowlist scalar fields and discard
content, paths, email, organization/account identity, terminal metadata, traces, and
raw bodies before persistence.

Inspect configuration scopes without persisting values. Refuse pre-existing
non-loopback or content-bearing exporters, never overwrite user/managed settings,
restore only if the configuration hash is unchanged, and disclose that shared
settings can affect CLI, Cowork, local sessions, and preview servers—not only Desktop
Code.

The exact installed Desktop build needs a user-approved trivial-request smoke that
tests restart, receiver outage, port conflict, and re-enable behavior. The release
claim is “no Tibo-originated external egress; optional loopback OTLP only; no
credential or private-endpoint access,” not literally zero socket traffic.

# Competitor findings

The strongest competitor lesson is durable capture, not a hidden recovery source.

| Pinned snapshot / maintenance | License | Useful coverage/pattern | Decision / unsafe assumption |
|---|---|---|---|
| [phuryn/claude-usage `3eea154`](https://github.com/phuryn/claude-usage/commit/3eea154474e93761f774ed38beeaf45baf838a45), 2026-07-10, still `main` | MIT | Standard/custom project roots; SQLite survives after an already-scanned source disappears | Borrow ledger idea; do not copy message-only identity/weak file generation |
| [Claude-Code-Usage-Monitor `c59a83b`](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/commit/c59a83bf943f329f0e61f1a29c760353ee1860a5), 2026-06-27, still `main` | MIT | CLI status line and explicit 365-day opt-in warehouse; Desktop excluded | Borrow retention/status-line UX; not Desktop evidence; strengthen winner/crash semantics |
| [ccusage `2ac5c7a`](https://github.com/ccusage/ccusage/commit/2ac5c7a6fb33c166fb071665968c2825d82c2b35), 2026-08-16 EDT, current/active | MIT | `CLAUDE_CONFIG_DIR`, nested/subagent JSONL, request-aware reconciliation | Differential oracle/small attributed reuse; do not embed the CLI wholesale |
| [CodexBar `45ca0b4`](https://github.com/steipete/CodexBar/commit/45ca0b4ef8c19adbb4a00e9634d4665c2ea20558), 2026-08-16, one commit behind; cited files unchanged | MIT | Only reviewed bounded Desktop embedded-root locator | Borrow locator/tests; its cache deletes disappeared rows and quota uses credential/private routes |
| [AI Observer `fd5114f`](https://github.com/tobilg/ai-observer/commit/fd5114f783f22df0d3dc9beb73dbe73f018fcd1e), 2026-06-18, still `main` | MIT | Transactional watcher, OTel field mapping, explicit OTel/JSONL differences | Borrow concepts; do not wrap Go/DuckDB or trust metric inserts as idempotent events |

Build the thin provider adapter and ledger extension in TiboTattle. Do not adopt a
competitor warehouse wholesale. Their databases preserve only rows captured before
cleanup; none reconstructs exact deleted per-event consumer-local transcript usage.
Separately persistent aggregate caches are a different, non-mixable evidence class.
The full pinned source, license, coverage, and reuse evidence is in the linked
[support findings](../research/2026-08-16-claude-code-desktop-support-findings.md#competitive-research).

# Required state model

```text
ingest generation: discovered -> verified -> staged -> committed
                                      \-> partial / raced / aborted

source: unseen -> present -> indexed -> missing_suspected
                                 |          |-> expired
                                 |          |-> inaccessible
                                 |          \-> present
                                 |-> replaced
                                 |-> lineage_unresolved
                                 \-> user_purged

candidate: accepted -> active_winner -> superseded
                         |-> legacy_unverified
                         \-> user_purged

projection: current -> rebuilding -> published
                         \-> retain_previous
```

Suggested durable contracts are `provider_source`, `usage_candidate` with keyed
request/message/session/iteration identity, `usage_winner`, provider-aware
`quota_observation`, `coverage_gap`, `projection_manifest`, and a scoped purge/
retention tombstone plus content-free receipt. Names can follow repository conventions;
the semantics are the gate.

# Revised acceptance matrix

1. Import a transcript through the actual production refresh path, simulate Claude
   cleanup, refresh again, and prove facts remain while the source becomes
   missing-suspected/evidence-backed-expired and coverage stays honest.
2. Make either root temporarily inaccessible or make enumeration incomplete; publish
   no deletions and retain the last-good projection.
3. Import a selected parent plus children with exact token/tool/cost aggregates,
   remove the parent, preserve accepted child facts/totals, and reconcile without
   duplication if it reappears or moves roots.
4. Change the cleanup marker during inventory; abort the generation and retry or mark
   it partial.
5. Append a larger partial response and prove exactly one logical winner and no double
   charge; repeat through atomic file replacement.
6. Roll the quota file to a smaller 30-day subset and prove prior Tibo observations
   remain; switch account scope and prove no uniqueness collision; then apply a
   higher-to-lower same-time correction with revision provenance and an unreadable/
   app-off interval that becomes a bounded quota gap rather than zero.
7. First-install after all matching transcripts expired and prove the UI shows a
   pre-adoption gap rather than zero or “complete.”
8. Bump the parser with the source present and rederive it; repeat with the source gone
   and retain but label the legacy row instead of claiming correction.
9. Use a mixed provider database with colliding timestamps/model-like values; fail a
   Claude projection rebuild and prove provider-specific reads, calibration, caches,
   the prior Claude generation, and all Codex data remain intact, byte-for-byte where
   appropriate.
10. Purge Claude before/inside/after a selected period and prove lifecycle, facts,
    quota, winners, coverage, manifests, keyed lineage, caches, WAL/SHM/journals,
    backups, diagnostics, and raw-Claude-ID canaries are handled without touching
    Codex or Claude files. Refresh while the raw files still exist and prove the scoped
    tombstone prevents resurrection.
11. Exercise unset/default, user/project/local/managed precedence, custom
    `CLAUDE_CONFIG_DIR`, invalid/minimum/90-day values, concurrent change, and managed
    lock. Prove the probe persists/logs only effective `cleanupPeriodDays` plus scope;
    keep-30 remains fully functional; guided-90 requires explicit action/privacy copy;
    and no prior gap is shown as repaired.
12. Verify quota-only refresh never replays transcripts and transcript-only refresh
    never rewrites quota history.
13. If aggregate caches are reviewed, prove they remain `aggregate_only`, never alter
    event winners, and render with distinct provenance/coverage.
14. If OTel is explored, verify exact-build receipt, persistence-level privacy
    allowlist, one-message-to-many-request identity, field-level transcript merge,
    duplicate/cumulative frames, retry exhaustion/recovery, missing client IDs,
    refusal/provider fallbacks, CLI/Cowork bleed, non-loopback/content-exporter
    refusal, durable-commit-before-ACK, collector outage, app restart, port conflict,
    unchanged-hash restoration, and a visible capture gap.

# Go/stop decision

Go only on the transcript/native-history Phase 0, with the durable-ledger and coverage
contracts designed before production ingestion. Hold OTel as a direct-distribution
extension until the exact-build smoke succeeds. Omit the loopback receiver from the
initial Mac App Store scope unless sandbox/helper feasibility is separately proven.

Stop if the implementation must erase facts when Claude removes a source, cannot
distinguish missing from zero, cannot purge longer-lived Claude history completely,
mixes provider caches/queries, or requires credentials/private endpoints for the
consumer product. Also stop any Claude-settings write path that cannot preserve
scope, permissions, concurrent changes, and unrelated sensitive values; guidance-only
retention remains acceptable.
