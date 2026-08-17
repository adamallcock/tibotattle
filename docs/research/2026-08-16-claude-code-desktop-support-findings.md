---
title: Claude Code Desktop Support Findings
date: 2026-08-16
type: research
status: phase-0-preparation-implemented-current-evidence
---

# Claude Code Desktop support findings

## Outcome

Supporting ordinary local Claude Code sessions launched from Claude desktop is
feasible without reading credentials or calling a private Anthropic endpoint. Two
passive owner-local sources cover different questions:

- `~/Library/Application Support/Claude/plan-usage-history.json` contains timestamped
  account quota percentages but not persisted reset timestamps.
- Desktop Code metadata selects top-level transcripts under `~/.claude/projects`;
  those transcript trees contain token usage but not a continuous plan-quota series.

The corrected retention conclusion is more important than the source discovery:
Claude's default 30-day cleanup is a hard *exact per-session backfill* boundary for
the verified passive consumer transcript source, not a second operating mode with
another canonical event log. Aggregate caches/reports may remain, but they have not
been verified as exact event reconstruction. If TiboTattle has already ingested
canonical facts, it can retain them after Claude removes the raw source. If the
transcript was gone before Tibo first observed it, metadata can prove activity but
exact tokens are unavailable. The product must record that as a gap and must not
estimate or zero-fill it.

The implementation therefore needs a Tibo-owned durable fact/winner ledger. A scan or
projection may be staged, but rebuilding an entire Claude slice solely from currently
present files would erase previously accepted history after normal Claude cleanup.

Anthropic also documents an OpenTelemetry surface for Claude Code and explicitly
labels Desktop Code-tab events with `service.name=claude-code-desktop`. It is a
promising optional forward-capture source, not historical recovery, quota/reset truth,
or guaranteed delivery. It requires an exact-build smoke, explicit user configuration,
privacy filtering, gap tracking, and transcript reconciliation before product use.

The implementation sequence is in the
[Claude Code Desktop Expansion Plan](../plans/2026-08-16-claude-code-desktop-expansion-plan.md).
The adversarial findings and test matrix are in the
[red-team review](../reviews/2026-08-16-claude-code-desktop-expansion-red-team.md).

## Scope and evidence boundary

The primary target is the installed **Claude Code desktop experience**, not a
terminal-launched CLI session. The 2026-08-16/17 local inspection was
content-minimized: it examined versions, file metadata, JSON keys, numeric usage
fields, counts, timestamps, and installed application/runtime code. It did not print
or retain prompts, responses, tool inputs/results, credentials, cookies, raw session
IDs, or raw organization identifiers.

| Component | Observed version |
|---|---:|
| Claude desktop app | `1.30096.5` |
| Desktop-bundled Claude Code runtime | `2.1.229` |
| Desktop VM Claude Code runtime | `2.1.219` |

These are point-in-time observations, not compatibility promises. Anthropic's current
documentation distinguishes local, SSH, and remote Code sessions and explains that
plan limits are shared across Claude surfaces. Local token history therefore cannot
prove that all movement in an account-wide meter came from this Mac. See
[Claude Code on desktop](https://code.claude.com/docs/en/desktop),
[Claude Code sessions](https://code.claude.com/docs/en/sessions), and
[shared usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work).

## Native desktop quota history

### Persisted format

The owner-local file was version 2 and had this content-minimized shape:

```json
{
  "version": 2,
  "samples": [
    {
      "t": 0,
      "org": "<organization identifier>",
      "u": {
        "fh": 0,
        "sd": 0,
        "xu": 0
      }
    }
  ]
}
```

| Stored key | Meaning |
|---|---|
| `t` | Observation time in Unix milliseconds |
| `org` | Sensitive organization scope; derive a private keyed value and discard raw input |
| `fh` | Five-hour utilization percentage |
| `sd` | Seven-day all-model utilization percentage |
| `xu` | Extra-usage utilization percentage when present |

The installed writer recognizes additional abbreviated provider/model-scoped weekly
meters. An adapter needs a reviewed registry plus an unknown-safe path; the three
locally observed keys are not an exhaustive schema.

### Local measurements

These measurements are a historical snapshot whose latest quota sample was
`2026-08-17T01:06:10.125Z`. The live rolling file has since advanced; no reproducible
content-free snapshot manifest/hash was retained for this first inspection, so Phase
0 must create one for future evidence. That UTC sample falls on the evening of
2026-08-16 in America/New_York, which is the document's local inspection date.

| Observation | Result |
|---|---:|
| File size at inspection | 552,568 bytes |
| Permissions | `0600` |
| Samples | 6,361 |
| First sample | `2026-07-18T01:07:00.886Z` |
| Last sample at inspection | `2026-08-17T01:06:10.125Z` |
| Distinct organization scopes | 1 |
| Observed utilization keys | `fh`, `sd`, `xu` |
| Persisted reset/window fields | 0 |

The history's organization identifier matched the organization path segment used by
the Desktop Code session store. This supplies an owner-local join. Only a keyed
account scope is needed downstream.

### Installed writer behavior

Inspection of the installed desktop app showed that it:

1. calls its own private organization-usage endpoint;
2. receives live utilization and reset values for its UI;
3. retains 720 hours, or 30 days, of local percentage history;
4. appends no more often than about 4.5 minutes;
5. normally refreshes every 15 minutes and may accelerate after interaction; and
6. does not persist the received reset timestamps in this history file.

TiboTattle should read the local history rather than reuse credentials or reproduce
the private request. Because this is an internal app format, parsing must be exact,
bounded, versioned, and fail closed.

### Claims supported by the quota file

It supports:

- observed five-hour/weekly/extra-usage percentages;
- timestamp and freshness;
- a rolling 30-day series currently present in Claude's file; and
- account continuity through a keyed local scope.

It does not support:

- the provider-reported future reset time shown in Claude's live UI;
- a stable public file contract;
- tokens or cost;
- proof that local transcripts explain all account usage; or
- retention beyond the current rolling source unless Tibo merges samples into its own
  ledger.

`resets_at_ms` should be null when no reset evidence exists. A utilization drop may be
labelled as an inferred historical boundary, never as a provider-reported countdown.
When Claude rolls an old sample out, Tibo must retain any already accepted observation;
it must not mirror the deletion.

## Desktop session and transcript evidence

Desktop task metadata lives under:

```text
~/Library/Application Support/Claude/claude-code-sessions
```

The inspected records carried session identifiers, timestamps, model/effort,
permission mode, title, and working-directory metadata. They contained no token usage.
They are source selectors and lifecycle evidence, not an accounting ledger.

### Top-level reconciliation

The tree contained 96 session records plus one scheduler index JSON object, which is
excluded from the session counts below. Ninety-five sessions had a `cliSessionId`; 68
matched a top-level transcript filename and 27 did not. One unavailable session lacked
a usable identifier.

| Metadata class | Count | Activity 0–7 days | Activity 8–30 days | Activity older than 30 days |
|---|---:|---:|---:|---:|
| Top-level transcript present | 68 | 13 | 41 | 14 |
| Identifier present, transcript absent | 27 | 0 | 0 | 27 |
| Identifier unavailable | 1 | 0 | 0 | 1 |

All 54 records whose activity timestamp was inside 30 days and whose identifier was
usable had a top-level match. But that does **not** mean “files older than 30 days are
gone.” Fourteen older-activity records remained because their transcript files had
newer modification times, including untimestamped lifecycle/title tail records.
Activity time determines accounting placement; file `mtime` determines cleanup/change
behavior.

The 27 missing matches are strongly consistent with cleanup, but should remain
classified as evidence-backed uncertainty rather than retroactively assigned tokens.
A scan of the inspected Desktop application-support roots found no matching
per-session token source for those IDs. Anthropic also documents aggregate/cached
artifacts such as `stats-cache.json` and `usage-data/`; they require separate format
evidence and are not assumed to be canonical event reconstruction.

### Hierarchical corpus

The current global projects corpus contains:

| File class | Count |
|---|---:|
| Top-level session transcripts | 73 |
| Nested `subagents` JSONL transcripts | 1,748 |
| Total JSONL transcripts | 1,821 |

The 68 Desktop-matched top-level parents own 1,747 nested transcript files across 28
parent sessions. One nested transcript is orphaned. This corrects the earlier apparent
finding that hundreds of old transcripts had survived independently: those were old
child records inside still-retained parent session trees.

The safe selection rule is hierarchical:

1. Desktop metadata selects the top-level parent in memory.
2. That parent authorizes bounded traversal of its sibling session/subagent tree.
3. Children inherit the selected Code-session lineage but keep root/subagent
   provenance.
4. A newly discovered orphan is not silently counted.
5. A previously accepted child is not cascade-deleted if its parent later disappears;
   it becomes lineage-unresolved until reconciled or explicitly purged.

Do not age-filter a file that still exists. Do not use child age as the cleanup
boundary.

### Confirmed cleanup mechanics

Anthropic documents `cleanupPeriodDays`, default 30 days and minimum one day, in
[Claude directory configuration](https://code.claude.com/docs/en/claude-directory).
The installed `2.1.229` runtime confirmed:

- default `30` when no valid positive setting applies;
- top-level transcript selection by `stat.mtime < cutoff`;
- recursive removal of the sibling session directory when the parent transcript is
  removed; and
- a local `~/.claude/.last-cleanup` marker.

The observed marker contained `2026-08-16T17:12:48.034Z`. At that sweep, none of the
73 top-level transcripts was beyond the default cutoff. At the later inspection, two
were about 30.2 days old, consistent with deletion at a future sweep. Settings files
currently visible on this Mac did not override `cleanupPeriodDays`, but user, project,
local, and managed settings can change the effective period.

Therefore:

- “30 days” is a default cleanup horizon, not a hard age predicate for accounting;
- a provider update or setting change can move it;
- first capture must inventory every still-present selected tree;
- a cleanup-marker change during discovery makes that generation raced/partial; and
- source disappearance is lifecycle evidence, never permission to delete Tibo facts.

Missing alone does not prove automatic cleanup: settings may pause/change cleanup,
the user may remove a file manually, or access may fail. Persist
`missing_suspected`, `cleanup_paused`, `config_changed`, `manual_missing`, and
`inaccessible` separately. Promote to `expired_by_provider` only with supporting
cleanup marker/telemetry and file evidence. Any unobserved interval is bounded by
adjacent successful scans with explicit confidence, not asserted as an exact period of
usage loss.

### Optional longer local retention

Claude Code officially supports `cleanupPeriodDays` in its hierarchical settings. The
default is 30, the minimum is 1, and files older than the effective period are cleaned
at startup. For all-project personal behavior, the user-scope property belongs in the
existing `~/.claude/settings.json`, or the equivalent under `CLAUDE_CONFIG_DIR`:

```json
{
  "cleanupPeriodDays": 90
}
```

This property must be merged into the existing object rather than replacing the file.
Claude Desktop reads the same settings files as the CLI. Scope precedence is managed,
command line, local, project, then user, so a user value may be overridden. See
[Claude Code settings](https://code.claude.com/docs/en/settings) and
[Desktop shared settings](https://code.claude.com/docs/en/desktop).

A fresh content-minimized check found the key unset in this Mac's readable user and
local files, no project/file-managed value, no managed preference, and the default
`CLAUDE_CONFIG_DIR`; the effective local behavior is therefore consistent with the
30-day default observed in the installed runtime.

TiboTattle should treat 90 days as an optional resilience recommendation, not an
Anthropic recommendation or automatic requirement. It gives Tibo more time to import
surviving sources after downtime and can protect still-present files before a future
cleanup sweep. It cannot restore a transcript already deleted.

The tradeoff is material: Claude documents that local transcripts are plaintext and
can include file contents, command output, pasted text, tool calls, and tool results;
the setting also governs other cleaned application data such as file history and plan
files. Increasing it does not change Anthropic's separate server-retention policy. See
[Claude local application data](https://code.claude.com/docs/en/claude-directory) and
[Claude data retention](https://code.claude.com/docs/en/data-usage).

Recommended product behavior:

- detect only the effective value and winning scope; discard unrelated settings;
- fully support users who retain the 30-day default;
- offer “Learn how to extend to 90 days” with explicit plaintext/privacy copy;
- respect higher-precedence/managed settings and `CLAUDE_CONFIG_DIR`;
- do not claim that extension repairs pre-existing coverage gaps; and
- keep the initial beta guidance-only. Any later one-click editor needs explicit
  confirmation, owner-permission preservation, exact-key atomic merge, concurrent-
  edit detection, and a separate configuration-write gate.

## Transcript accounting behavior

Structural scanning found no continuous quota rows in the transcript corpus:

| Observation | Result |
|---|---:|
| Transcript JSONL files | 1,821 |
| Structured `rate_limits` keys | 0 |
| Structured `rate_limit_event` rows | 0 |
| Claude usage-limit marker strings | 0 |

In the latest 50 transcript files, 35,807 rows carried usage. There were 9,387
repeated provider message IDs and 619 repeated IDs whose output count changed. Raw
rows must therefore be reconciled into a final/largest logical-message winner rather
than summed.

The accepted
[Claude transcript semantics decision](../decisions/2026-07-25-claude-transcript-usage-semantics-decision.md)
still applies. The exporter groups on secret-keyed provider message identity, rejects
conflicting input/cache invariants, selects the final/largest output occurrence,
expands explicit iterations without adding the top-level aggregate, and preserves
combined output/cache TTL fields.

Production ingestion needs a metadata-selected multi-root inventory and durable
candidate/winner state. A source-offset event key alone cannot represent a later
winner update safely. The durable layer must keep stable logical identity across
append, replay, atomic replacement, and later source cleanup.

## Longer-lived Tibo history is a product/privacy decision

The point of the Tibo ledger is to outlive Claude's rotating raw source. That changes
the retention promise and cannot be hidden as a cache optimization.

Required boundaries:

- no Claude prompt, response, path, raw session/account/organization ID, tool input, or
  result in any database table, including existing legacy identity tables, or in a
  cache, journal/sidecar, backup, log, diagnostic, UI payload, or error;
- keyed low-cardinality provider/source/lineage identity only;
- visible capture start and local retention explanation;
- user-selected retention policy if the product does not adopt a clearly disclosed
  bounded default; and
- provider/period purge that splits or recomputes source lifecycle, winner revisions,
  coverage gaps, manifests, and keyed lineage at the selected boundaries; invalidates
  caches, WAL/SHM/journals, and backups; leaves only an approved content-free receipt;
  and touches neither Codex nor Claude's own raw files; and
- a minimal provider/source-generation/time-range tombstone, or explicit capture-
  disabled state, so a scan cannot resurrect purged/expired facts while Claude's raw
  files remain.

Claude deleting a transcript must not silently delete Tibo's content-free accounting
facts. Conversely, Tibo must never imply that its longer-lived aggregates were also
removed unless its purge actually completed.

## Official OpenTelemetry surface

Anthropic's
[Monitoring Claude Code usage](https://code.claude.com/docs/en/monitoring-usage)
documentation now provides an official observation surface. Relevant facts include:

- Desktop Code-tab sessions use `service.name=claude-code-desktop`;
- `claude_code.api_request` logs expose request-level scalar input, output,
  cache-read/cache-creation, model, estimated cost, query source, and conditional
  request identifiers;
- content-bearing prompt, tool, assistant, and raw API-body flags exist and are
  disabled by default; and
- standard telemetry can still contain email, organization/account/session identity,
  terminal metadata, and paths.

This improves the forward-capture option but does not make it automatic or canonical.

### Delivery and identity limitations

- Anthropic's public contract does not specify OTLP durability, replay, offline
  queuing, or shutdown flushing. Delivery during a Claude exit, startup race, or
  receiver outage is unverified and must be fault-tested; any affected interval is a
  coverage gap, not presumed complete.
- `request_id` may be absent when the response lacks the header.
- `client_request_id` is conditional and can describe only the final attempt.
- event sequence is monotonic only within a session.
- retry attempts are not fully observable as independent billing events.
- `api_request.query_source` is a subsystem string such as a main REPL, compaction, or
  a subagent name, whereas token/cost metrics categorize query source as `main`,
  `subagent`, or `auxiliary`. Normalize the two explicitly; do not assume metric
  category values appear unchanged on request events. Their relationship to a
  user-facing transcript total still requires reconciliation.
- `subagent_completed.total_tokens` is a final request footprint, not a second total to
  add to per-request events.
- OTel has no plan quota utilization/reset event equivalent to native history.

Use request logs, not aggregate metrics, as the candidate event lane. Store an ingest
ID, keyed HMAC of the canonical minimized scalar payload, conditional identity tuple,
and identity-strength grade. Detect conflicting deliveries instead of silently
summing them. Label the result as API usage observed by OTel, not exact billing.

Identity should retain keyed
forms of request/client-request/message/session IDs plus iteration/attempt ordinal.
One transcript message may expand to multiple provider iterations. Reconcile at field
level: OTel may strengthen live request identity, while transcripts retain richer
five-minute/one-hour cache-write and user-facing message semantics. Never replace a
richer transcript field with a null/aggregate OTel value or add both source totals.

Anthropic's [changelog](https://code.claude.com/docs/en/changelog) says `2.1.214`
fixed token/cost double counting when streams contained multiple cumulative usage
frames and is the minimum for that known fix/client-request-ID support. It does not
prove delivery, privacy, or end-to-end correctness. Accept historical string-versus-
current numeric attribute encodings only through a fixture-backed compatibility
decision. The version floor alone is insufficient: fixtures/smoke must cover multiple
cumulative frames, retry exhaustion and recovery, absent intermediate retry events,
missing client request IDs on third-party/non-streaming fallbacks, refusals, and
server fallback events.

### Privacy and configuration boundary

Defaults are not the privacy filter. A Tibo receiver must:

- be explicit and reversible;
- configure logs as OTLP, metrics/traces as `none`, and an explicit signal-specific
  loopback endpoint with no external headers;
- bind only to loopback with strict body/rate limits;
- allowlist only required scalar accounting fields before persistence;
- drop content, paths, email, account/organization identity, terminal metadata,
  traces, raw bodies, redacted content fields/lengths, host-authored MCP names, and
  unknown events;
- never log rejected payloads; and
- avoid overwriting user-managed or administrator-managed OTel settings; refuse or
  warn when content, raw-body, or file-mode telemetry flags are already active.

Accept the OTLP envelope, filter unneeded records individually, durably commit accepted
request records before ACK, and fail only malformed/uncommitted batches; rejecting an
entire mixed batch because it also contains an unneeded event can lose valid request
observations. Pin HTTP/protobuf or gRPC and the correct signal path, and expose only
content-free dropped/unknown counters.

Desktop environment configuration is startup-sensitive and may affect all local
sessions/preview servers; shared Claude settings can also affect CLI/Cowork rather than
only the Code tab. The exact installed build therefore needs a user-approved trivial-
request smoke covering restart, CLI/Cowork bleed, outage, port conflict, and re-enable.
Inspect the relevant settings/environment scopes without persisting their values;
refuse any existing non-loopback or content-bearing exporter and restore only if the
configuration hash remains unchanged. Disable only Tibo-created stale configuration
after crash/exit.
The accurate privacy claim is “no Tibo-originated external egress; optional loopback
OTLP only; no credential or private-endpoint access.”

OTel is best treated as an optional direct-distribution extension. The initial Mac App
Store scope should omit the local listener until sandbox entitlement/helper behavior
is separately proven.

### Retention sweep telemetry

Claude Code `2.1.227+` can emit `claude_code.retention_sweep` only when OTel logs are
configured. It is emitted at most once per session and may be absent because of the
24-hour same-machine delay, a short session, or `claude -p --bare`. Its
deleted/retained counters are floors rather than exact totals, and deletion counters
appear only for `result=complete`. It is useful coverage diagnostic evidence, not a
restoration source; local cleanup-marker/source inventory checks remain necessary.

## Other local artifacts and non-sources

### `stats-cache.json`

Anthropic's [Claude directory reference](https://code.claude.com/docs/en/claude-directory)
documents `stats-cache.json` as an aggregate cache used by `/usage`. It can persist
aggregate usage until deleted, but it was absent locally during this
inspection and lacks the needed event/session attribution. Treat it as an optional
coarse discrepancy signal, never as canonical backfill or a repair source.

The same reference documents `usage-data/` as cached usage-report/per-session analysis
data that persists outside automatic transcript cleanup. Its current local format,
identity, corrections, and continuity were not established here. Phase 0 may inspect
it content-minimally behind a separate privacy/format gate and, if useful, label it
`aggregate_only`; it must not be mixed into canonical event winners or presented as
exact deleted-transcript reconstruction.

`history.jsonl` also persists independently, but it is command/prompt history rather
than an accounting source and is out of scope for privacy and usefulness reasons.

### Status line

The existing Tibo status-line command in `~/.claude/settings.json` remained stale while
Desktop Code sessions were active. Anthropic's
[status-line documentation](https://code.claude.com/docs/en/statusline) is useful for
terminal Claude Code, but does not establish ordinary Desktop Code-tab callbacks.

### Desktop metadata, application logs, export, and account export

Metadata and app logs can establish activity/source lifecycle, not tokens after the
transcript is gone. `/export` and account data export are user-driven workflows, not a
passive local continuity contract. None should be presented as automatic 30-day
recovery.

### Sparse local-agent audit events

Local-agent audit files contained three exact `rate_limit_info` objects with reset and
status fields. They are sparse “limit encountered” evidence and the enclosing records
can contain sensitive content. Keep them out of the baseline quota path unless a
separate exact-record privacy review approves a scalar-only projection.

## Corrected comparison with TiboTattle's Codex implementation

TiboTattle has independent Codex evidence paths:

1. local rollout JSONL supplies historical token changes and attached rate-limit
   observations; and
2. foreground refresh may start `codex app-server` and request a fresh sanitized
   account/rate-limit observation.

Quota refresh does not make token replay more expensive and must not invalidate a
valid token-accounting cache. “Connect Claude to the replay-safe cache” means
canonicalize repeated/partial transcript rows once, persist safe winners, and build
derived prices/totals idempotently. The expensive part is global message
canonicalization, not the Claude pricer itself.

The current Codex incremental index intentionally leaves facts whose rollout source
rotated away untouched. That is the right retention concept. Other local-analysis and
fresh-build paths can remove missing sources or replace a whole database, so the
Claude design must audit every write/read/cache path rather than assuming the word
“unified” already guarantees provider isolation and durability.

Specifically, the production `local-analysis-index` currently gives source-backed
usage/quota facts cascading foreign keys and deletes sources missing from refresh.
Claude cannot reuse that path as its durable ledger unchanged. Either add a new
non-cascading provider ledger and make analysis a derived projection, or first migrate
the existing source deletion into lifecycle tombstones. Test the actual refresh path.

## Schema implications

### No new numeric output component is required if provenance is retained

The provider-neutral candidate/accounting path supports uncached input, cache read,
aggregate and duration-specific cache writes, text output, reasoning output, and
combined output. Store Claude `output_tokens` as combined output in the durable fact.
The production `local-analysis-index` itself has text/reasoning columns but no combined
column/output-kind provenance, so it still requires provider/source/output-kind
provenance or a projection from a separate provider ledger.

For an existing usage table that visually requires text and reasoning columns, it is
acceptable to project `text = combined` and `reasoning = 0` for Claude as a display
compatibility rule. The stored source fact and explanatory copy must still say
“combined output”; the zero is not evidence that Anthropic reported no hidden
reasoning.

### Provider/source/coverage widening is required

The current unified index has no provider on `usage_event`, makes `model_id` globally
unique, names a tier field `codex_speed_mode`, gives `account_scope` no provider, and
deduplicates quota on `(observed_at_ms, limit_id, slot)`. Current read/cache paths can
also assume Codex-only facts.

Before Claude production rows, add provider identity to every affected dimension,
fact, uniqueness key, query, calibration/pricing path, projection manifest, and cache
namespace. Do not infer provider from model name. Prove that rebuilding Claude leaves
Codex byte/semantically unchanged and vice versa.

Claude additionally needs:

- source lifecycle instead of source-delete cascades;
- immutable candidate plus stable logical-message winner/supersession state with HMAC
  provider request ID, client request ID, transcript request/message/session IDs, and
  iteration/attempt ordinal for one-message-to-many-request reconciliation;
- source/file generation handling for append, truncation, and replacement;
- provider/account-aware durable quota observations with revisions;
- interval-based coverage gaps and adoption/capture timestamps;
- parser state for retained facts whose raw source no longer exists; and
- provider/source-generation/time-range purge/expiry tombstones that prevent immediate
  re-import, plus content-free receipts.

### Quota contract widening is narrow but real

Current export contracts assume status-line/session scope, required resets/durations,
and no reviewed Claude meter registry. Native desktop history has account scope,
utilization, and timestamp but no persisted reset or session identity.

Add a versioned `claude_desktop_plan_history` authority, account scope without a
fabricated session, nullable reset evidence, reviewed meter identities, and an unknown
meter path. Keep any outbound contribution change outside this local plan until a
separate privacy/minimization review.

## Competitive research

Most quota/menu apps obtain reset parity by reading an OAuth credential, importing a
web session, or driving `/usage`. Those choices remain outside TiboTattle's passive
consumer boundary. The strongest reusable patterns concern local durable capture and
source discovery.

| Project snapshot / maintenance as of 2026-08-16 EDT | License | Verified source coverage / semantics | TiboTattle decision |
|---|---|---|---|
| [CodexBar `45ca0b4`](https://github.com/steipete/CodexBar/commit/45ca0b4ef8c19adbb4a00e9634d4665c2ea20558), 2026-08-16; `main` one commit newer, cited files unchanged | [MIT](https://github.com/steipete/CodexBar/blob/45ca0b4ef8c19adbb4a00e9634d4665c2ea20558/LICENSE) | Only reviewed app with verified bounded [Desktop embedded-root discovery](https://github.com/steipete/CodexBar/blob/45ca0b4ef8c19adbb4a00e9634d4665c2ea20558/Sources/CodexBarCore/Providers/Claude/ClaudeDesktopProjectsLocator.swift#L3-L55); compact scanner cache removes rows when sources disappear; quota uses credentials/web/PTY | Borrow locator/parser tests; do not wrap the app/cache or private quota routes |
| [ccusage `2ac5c7a`](https://github.com/ccusage/ccusage/commit/2ac5c7a6fb33c166fb071665968c2825d82c2b35), 2026-08-16 EDT; active and current `main` | [MIT](https://github.com/ccusage/ccusage/blob/2ac5c7a6fb33c166fb071665968c2825d82c2b35/LICENSE) | `CLAUDE_CONFIG_DIR`, standard/config roots, recursive nested/subagent JSONL; strong [`message.id + requestId` reconciliation](https://github.com/ccusage/ccusage/blob/2ac5c7a6fb33c166fb071665968c2825d82c2b35/rust/adapters/claude/src/lib.rs#L118-L193); no Desktop embedded roots or durable history | Differential/reconciliation oracle; consider small attributed parser reuse, not the CLI/runtime wholesale |
| [phuryn/claude-usage `3eea154`](https://github.com/phuryn/claude-usage/commit/3eea154474e93761f774ed38beeaf45baf838a45), 2026-07-10; still current `main`, v1.5.5 | [MIT](https://github.com/phuryn/claude-usage/blob/3eea154474e93761f774ed38beeaf45baf838a45/LICENSE) | Standard/Xcode/custom project roots; recursive JSONL; SQLite survives only for already captured rows; message-ID last-record-wins and weak file generation | Borrow durable-ledger idea only; build Tibo identity/generation semantics |
| [Claude-Code-Usage-Monitor `c59a83b`](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/commit/c59a83bf943f329f0e61f1a29c760353ee1860a5), 2026-06-27; still current `main` | [MIT](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/blob/c59a83bf943f329f0e61f1a29c760353ee1860a5/LICENSE) | Standard/config project roots; CLI status-line capture; optional [365-day warehouse](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/blob/c59a83bf943f329f0e61f1a29c760353ee1860a5/src/claude_monitor/data/warehouse.py#L25-L90); README excludes Desktop | Borrow status-line/retention UX and staging concepts; CLI-only evidence, do not wrap |
| [AI Observer `fd5114f`](https://github.com/tobilg/ai-observer/commit/fd5114f783f22df0d3dc9beb73dbe73f018fcd1e), 2026-06-18; still current `main` | [MIT](https://github.com/tobilg/ai-observer/blob/fd5114f783f22df0d3dc9beb73dbe73f018fcd1e/LICENSE) | Custom/standard/config roots; transactional watcher; explicitly different [OTel and JSONL totals](https://github.com/tobilg/ai-observer/blob/fd5114f783f22df0d3dc9beb73dbe73f018fcd1e/README.md#L956-L1123); OTel metric inserts lack event identity | Borrow watcher transaction/field mapping; build Tibo's idempotent receiver, do not wrap Go/DuckDB |

These stores preserve only what they captured before cleanup. None supplies an exact
passive consumer-local reconstruction of already deleted transcripts. Build a thin
Tibo adapter and ledger extension rather than adopting a competitor database
wholesale. All five snapshots are MIT, so small attributed reuse is legally plausible,
but toolchain, dependency, privacy, and maintenance costs still favor adapting the
concepts rather than wrapping an application.

Anthropic's Enterprise
[Compliance API](https://platform.claude.com/docs/en/manage-claude/compliance-api)
is the only authenticated server route found that may retain exact session transcripts
beyond the local cache; aggregate-only local artifacts are discussed separately. The
session-transcript endpoints are a Claude Enterprise beta and require a Compliance Access Key
with `read:compliance_user_data`; Admin API keys cannot access them, and local capture
requires the user to be signed in with the Enterprise account. It is not a general
Free/Pro/Max recovery path. The documented session/activity surface does not document
a plan quota percentage or reset meter. See
[Compliance sessions](https://platform.claude.com/docs/en/manage-claude/compliance-sessions).

## Recommended implementation boundary

### Baseline consumer/local beta

1. Detect `CLAUDE_CONFIG_DIR` and read only exact allowlisted project/session/quota
   subpaths; never broadly scan settings, auth, plugins, or unrelated root contents.
2. Detect effective `cleanupPeriodDays`; fully support 30 days and offer guided,
   explicit 90-day retention as an optional recovery buffer.
3. Import every selected parent/child transcript still present; never age-filter it.
4. Merge canonical candidates/winners into a provider-isolated durable Tibo ledger.
5. Merge native plan-history samples into a separate durable quota ledger.
6. Record capture start, source lifecycle, and explicit gaps.
7. Retain facts when Claude removes a source; expose parser-legacy state when source
   dependent rederivation is impossible.
8. Provide clear longer-retention, tombstone, and purge semantics.
9. Scope initial accounting to detected Anthropic first-party subscription/Desktop
   sessions; API-key, Bedrock, Vertex, and Foundry backends remain unsupported until
   their detection/pricing/provenance is reviewed.
10. Present Claude separately in the menu/dashboard, with quota contamination and
   unsupported-surface caveats.

### Optional extensions

- OTel: direct-distribution, explicit opt-in, forward-only, loopback privacy filter,
  request-log ledger, transcript reconciliation, delivery-gap UI.
- Claude raw retention: keep 30 days fully supported; offer guided 90-day opt-in as a
  privacy-disclosed resilience aid, not a substitute for Tibo's durable ledger.
- Terminal CLI: retain status-line and transcript-specific provenance.
- Cowork: separate surface using compatible grammar only after explicit source/UI
  decision.
- SSH/remote/cloud: coverage-only until direct evidence.
- Enterprise Compliance: separate authenticated connector and consent model.

## Current decision

Proceed with the revised plan's **Phase 0 only**. The provider-neutral token components
and existing Claude pricer are reusable; the production analysis index still needs
provider/source/output-kind provenance or a provider-ledger projection. The release-
blocking work is durability and provenance: hierarchical inventory, provider
isolation, logical winners, immutable quota merge, coverage gaps, parser legacy state,
and honest longer-retention deletion controls.

Do not frame the product as “logs for 30 days, something else after 30 days.” Frame it
as “backfill from whatever Claude still retains, then durable local preservation from
the point Tibo starts observing.” OTel can harden forward capture after a separate
receipt; it cannot turn an already missing consumer transcript into recoverable token
event history. Separately reviewed persistent caches may provide aggregate-only
evidence, never an exact reconstruction claim.

## 2026-08-16 implementation checkpoint

The preparation slice is now executable rather than plan-only. It includes a bounded
Desktop inventory, effective-retention detector, native quota parser, provider-aware
durable-ledger lifecycle prototype, frozen fixtures, explicit combined-output view
contract, and selected-corpus benchmark. See the
[implementation receipt](../receipts/2026-08-16-claude-desktop-phase0-implementation-receipt.md)
and [ledger decision](../decisions/2026-08-16-claude-desktop-durable-ledger-decision.md).

The live corpus refreshed the structural snapshot to 68 selected parents, 1,752
selected children, 27 missing parents, and one new orphan. It also established a new
blocker: the corrected benchmark completed in roughly 25.9 seconds with a
1,938,341,888-byte process RSS peak. Correctness is sufficient to continue Phase 0;
performance is not sufficient for an automatic background production path.
