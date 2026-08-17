---
title: Claude Code Desktop Expansion Plan
date: 2026-08-16
type: plan
status: production-shadow-preparation; user-facing-gates-open
owners:
  - product
  - local-companion
  - accounting
  - macos
  - privacy
---

# Claude Code desktop expansion plan

## Decision

Proceed with a bounded Phase 0 for ordinary **local Claude Code sessions launched
from the Claude desktop Code tab**. Do not start the user-facing beta until the
durable-ledger, coverage, provider-isolation, and retention/purge contracts below
have passed their gates.

The first release is scoped to Anthropic first-party Claude subscription sessions
whose Desktop metadata/account join is proven. API-key, Bedrock, Vertex, Foundry, and
other backends remain unsupported/coverage-visible until backend detection and
provider-specific pricing/provenance are designed; do not hardcode them as
`claude_subscription`.

The first release uses a separate Claude usage/quota/source/projection/cache namespace.
It does not require a broad provider-column migration of the existing Codex production
tables. If a shared boundary is introduced later, NULL or empty provider values are a
one-way compatibility case for legacy Codex rows only: interpret them as
`openai_codex` during migration, then require an explicit provider on new writes. No
NULL/empty value may silently select Claude.

The passive consumer product uses two independent source lanes:

1. account-level quota percentages from Claude desktop's native
   `plan-usage-history.json`; and
2. token usage from Code-session metadata joined to selected Claude transcript
   trees under `~/.claude/projects`.

Do not read Claude credentials, import browser cookies, call private Claude usage
endpoints, launch a hidden CLI `/usage` session, or present inferred resets as
provider-reported.

The plan does **not** branch at a session's thirtieth day. It branches on whether
TiboTattle observed the source before Claude removed it:

| State | Behavior | Honest product claim |
|---|---|---|
| Transcript is still present at adoption | Import it regardless of record age, including proven child transcripts, and merge canonical winners into Tibo's ledger | “Imported from locally available Claude Code history” |
| Tibo previously imported a source that Claude later removes | Retain accepted token facts; mark the source expired/missing; continue from new observations | “Preserved locally by TiboTattle after source cleanup” |
| Transcript was already gone before adoption | Store only content-free activity/coverage evidence; do not estimate or zero-fill tokens | “Usage before capture is unavailable” |
| Tibo is unavailable longer than Claude retains an unobserved source | Record a capture gap | “Some usage was not observed” |

Anthropic's documented OpenTelemetry surface is a possible explicit, forward-only
continuity extension. It cannot backfill deleted consumer history, does not supply
plan quota/reset truth, and is not a prerequisite for the transcript/native-history
beta.

The evidence report is in
[Claude Code Desktop Support Findings](../research/2026-08-16-claude-code-desktop-support-findings.md).
The adversarial review and acceptance matrix are in
[Claude Code Desktop Expansion Red-Team Review](../reviews/2026-08-16-claude-code-desktop-expansion-red-team.md).

## Supported-surface boundary

| Surface | Initial status | Reason |
|---|---|---|
| Local Claude desktop Code tab | Phase 0 target | Metadata, parent transcripts, and bounded child trees are locally evidenced |
| Scheduled local Code task | Discovery target | Two local metadata records carry a scheduled-task identifier; source continuity is not yet proven |
| Archived/forked local Code task | Import when source is present | Lifecycle flags do not establish a separate token source |
| Terminal Claude Code CLI | Supplemental/later | Existing exporter and status-line adapter cover much of it, but it is not the requested primary product |
| Cowork/local agent | Deferred separate provider surface | It has compatible embedded transcripts but is not the Code tab |
| Remote Control with local execution | Discovery target | May share local transcript behavior; must be proven rather than inferred |
| SSH or provider-hosted/cloud Code | Coverage-only until proven | Local token evidence may be absent or partial |
| Claude web/chat/mobile/another device | Quota contamination only | It can move the account meter without creating a local Code transcript on this Mac |
| Enterprise Compliance API | Separate future connector, not fallback | Authenticated enterprise product, network/authorization boundary, not consumer quota |

## Reusable implementation

This remains an integration project rather than a new Claude parser.

- The existing
  [Claude transcript exporter](../../src/application/export-sources/claude-transcript-export.js)
  canonicalizes repeated provider messages, validates input/cache invariants,
  handles provider iterations, preserves cache-write TTL components, classifies
  tools, and emits combined output without retaining conversation content.
- [Privacy-safe normalization](../../src/export/safe-records.js) already emits
  `anthropic_claude_code` usage candidates.
- The provider-neutral pricing registry already prices Claude combined output and
  cache components with explicit unknown/unpriced coverage.
- The provider-neutral candidate/accounting path already carries combined output, so
  no new numeric output component is required if the Claude durable fact retains an
  explicit combined-output kind. The rich canonical boundary must also retain the
  validated model declaration and cache-write aggregate plus five-minute/one-hour TTL
  split. A compatibility view may render Claude as `text = combined` and
  `reasoning = 0`, provided the zero is a display projection rather than a claim that
  Anthropic supplied that split.
- The strict
  [Claude winner pricing adapter](../../src/claude-desktop-pricing.js) adapts that
  rich canonical winner to the existing event-time registry. It is an independently
  testable adapter exercised by the Claude prototype ledger/incremental path with a
  standalone replay-safe summary cache. A disabled-by-default internal local-companion
  controller can now invoke this path without adding a route, response field, setting,
  upload, or installed UI integration. Quota
  ingestion remains independent and authoritative from native
  `plan-usage-history.json`; token pricing must never be used as a quota substitute.
- Codex's incremental unified index already demonstrates an important retention
  rule: rows whose source rotated away can remain. Claude must preserve that rule
  across every provider-specific ledger and projection path.

The new work is source inventory, durable Claude facts, logical-winner state,
quota-history merge, provider-aware projections/caches, coverage, authorization,
retention controls, and installed-product evidence.

## Evidence snapshot

The content-minimized measurements below are a historical snapshot whose latest
quota sample was `2026-08-17T01:06:10.125Z`; the rolling live files have already
advanced since then. That UTC time is the evening of 2026-08-16 in America/New_York.
Phase 0 must preserve a content-free manifest and hash for each future benchmark
snapshot. The inspection established:

- Claude desktop `1.30096.5`, bundled Code runtime `2.1.229`, and VM runtime
  `2.1.219`;
- 6,361 owner-only quota samples spanning 30 days with `fh`, `sd`, and `xu`
  percentages but no persisted reset timestamps;
- 96 desktop Code session records, 95 with `cliSessionId`, excluding one scheduler
  index JSON object in the same tree;
- 68 metadata identifiers matched top-level transcripts and 27 older identifiers
  did not; one record lacked a usable identifier;
- 73 top-level project transcripts and 1,748 nested subagent transcripts in the
  current corpus;
- the 68 matched desktop parents own 1,747 nested transcripts; one nested transcript
  is orphaned and must not be admitted blindly;
- no top-level transcript was older than 30 days at the observed cleanup marker;
  older child rows survived because cleanup is based on the parent transcript;
- the installed runtime defaults `cleanupPeriodDays` to 30, permits a configured
  positive integer with a one-day minimum, and deletes a top-level transcript plus
  its sibling session directory based on top-level file modification time;
- 14 metadata records whose activity timestamp was older than 30 days still had
  transcripts because non-accounting tail records refreshed file modification time;
- repeated provider message IDs and changed output totals confirm that raw JSONL rows
  cannot be summed;
- native quota history rolls independently at 720 hours; and
- status-line output remained stale while Desktop Code sessions were active.

The evidence supports a local Code Phase 0. It does not establish completeness for
remote/cloud/SSH sessions, first-install history already unavailable for any reason,
or OTel delivery in the exact installed Desktop build.

## Target architecture

```text
Desktop metadata -> selected parent/child inventory -> transcript candidates
                                                       |
Optional OTel logs ------------------------------------+-> canonical identity
                                                            and winner ledger
Native quota history -------------------------------------> durable quota ledger

winner/quota ledgers -> provider-specific projections -> menu/dashboard/cache
coverage/source state ---------------------------------> coverage and freshness UI
```

For the initial release, the Claude ledger and quota namespace feed Claude-specific
projections/cache entries alongside, but not through a broad rewrite of, the existing
Codex index. The native quota lane and the canonical usage/pricing lane may refresh
independently and must expose their own provenance and freshness.

### Source precedence

| Metric | Primary source | Reconciliation/fallback | Never use as substitute |
|---|---|---|---|
| Current/passive quota percentage | Native desktop plan history | Provider-labelled CLI status line only for CLI scope | OTel or transcript tokens |
| Provider-reported future reset | Exact local event only if separately approved | Unavailable | Nominal window math or utilization drop |
| Historical local Code tokens | Tibo durable winner ledger | Import selected transcripts while present | Metadata/app logs after transcript deletion |
| Live request usage, optional | Verified OTel `api_request` log | Transcript request/message reconciliation | OTel aggregate metrics alone |
| User-facing conversation total | Canonical transcript winners | Proven OTel subset with shared identity | Sum of OTel plus transcript totals |
| API-level observed total | OTel request events when opted in | None | Claiming it equals subscription billing |
| Aggregate-only continuity | Separately reviewed `stats-cache.json` / `usage-data/` artifacts | `aggregate_only` coverage/discrepancy lane | Mixing aggregate totals into per-event winners or claiming exact reconstruction |

Cross-source reconciliation is field-level, not “one source wins the row.” OTel may
strengthen live request identity/API observation, while the transcript may preserve
richer user-facing message semantics and five-minute/one-hour cache-write detail.
Retain both provenances and conflicts; never replace a richer transcript field with an
aggregate/null OTel field. One transcript message can contain multiple provider
iterations, so Phase 0 must prove the one-message-to-many-request mapping.

### Durable-versus-derived boundary

The durable layer is append/merge, not a provider-slice mirror:

- source disappearance changes lifecycle state but never removes accepted facts;
- immutable candidates retain source generation, parser version, and typed tokens;
- a stable HMAC logical-message identity selects one active winner and records
  supersession;
- price and chart projections are rebuildable, provider-scoped generations;
- projection publication records a ledger high-water mark and retains the previous
  generation on failure; and
- only an explicit Tibo user purge or a previously selected automatic-retention policy
  removes retained Tibo evidence and accepted facts; both create a scoped tombstone
  that prevents re-import while the raw source remains, and neither deletes Claude's
  transcript/history files.

A staged current-source scan is allowed as an ingestion technique. Replacing the
entire durable Claude slice from that scan is not.

**Architecture choice:** do not use the current `local-analysis-index` source/fact
tables as Claude's durable ledger while their refresh path deletes absent sources and
their foreign keys cascade that deletion into facts. Add a non-cascading
Claude usage/quota namespace instead, then make the existing analysis/cache surfaces
derived projections. Do not migrate every existing Codex table merely to add Claude.
Phase 0 must exercise the eventual production refresh path and prove it cannot bypass
the ledger/tombstone rules. A later shared-boundary migration may use the explicit
legacy `NULL`/empty -> `openai_codex` compatibility rule above, but new Claude writes
must never rely on that fallback.

## Storage and contract decisions

The exact names can follow repository conventions, but the following semantics are
required before production writes:

| Contract | Required widening or addition |
|---|---|
| Product/provider partition | First release uses a separate Claude usage/quota/source/projection/cache namespace; keep the existing Codex schema unchanged. If a shared boundary is later introduced, provider must participate in its keys, queries, and cache manifests, with legacy NULL/empty values backfilled only as `openai_codex` before new writes become explicit-provider-only |
| Usage candidate | Provider/backend, HMAC logical-message ID, candidate ID, HMAC source/session/request/client-request/message IDs, iteration/attempt ordinal, source generation/offset, event time, parser version, typed token components, output kind, state |
| Usage winner | Logical-message ID, selected candidate, revision, identity strength, supersession/conflict metadata |
| Source state | Provider/backend/surface/account, HMAC source/parent keys, lifecycle including `missing_suspected`, `cleanup_paused`, `config_changed`, `manual_missing`, evidence-backed `expired_by_provider`, `inaccessible`, and `aggregate_only`; first/last seen; missing since; parser state; last committed generation; accepted counts |
| Quota observation | Provider, authority/source, HMAC account scope, meter/duration/slot, observation time, percentage, nullable reset, source generation and revision |
| Coverage gap | Provider/surface/scope, interval, reason, confidence, evidence generation |
| Projection manifest | Provider, generation, ledger high-water mark, parser/pricer versions, coverage summary, previous generation |
| Retention/purge receipt | User-selected local policy; provider/source-generation/time-range tombstone preventing re-import; before/inside/after-period split/recompute rules; cache/WAL/SHM/backup invalidation; HMAC-lineage handling; and the one content-free receipt allowed to remain after an explicit Tibo-only purge or configured expiry |
| Tier semantics | Neutral speed/mode dimension or provider-specific dimension; do not call Claude speed a Codex mode |
| Quota authority | Native Claude `plan-usage-history.json` is authoritative for observed account quota percentages and nullable reset evidence; transcript tokens, OTel, and pricing are not quota substitutes |
| Pricing boundary | Price only from a rich canonical winner retaining validated model declaration, cache-TTL detail, and combined-output kind; treat pricing as API-price-equivalent derived data, independent of quota ingestion |

The present Codex quota uniqueness `(observed_at_ms, limit_id, slot)` is insufficient for
the separate Claude namespace. The Claude key must include account scope, meter
identity, and source revision semantics so account/provider collisions are impossible.
A corrected lower percentage at the same timestamp must follow an explicit revision
rule rather than “higher value always wins.” This does not authorize changing the
existing Codex key in the first Claude release.

The existing quota export contracts also require a narrow versioned widening:

- add `claude_desktop_plan_history` authority/source;
- permit account scope with no fabricated session scope;
- admit nullable reset evidence;
- add reviewed Claude meter IDs with unknown-safe fallback; and
- keep outbound contribution changes out of scope until separately authorized.

Parser corrections for a source Claude has already deleted cannot be replayed. Such
facts remain locally useful but must become `legacy_unverified` or equivalent rather
than silently inheriting a newer parser claim.

## Phase 0 — bounded architecture and evidence spike

### 0A. Privacy-safe fixtures

Create minimized fixtures with no real content, raw path, identifier, credential, or
tool payload:

- quota history v2: all observed meters, unknown meter, multiple organizations,
  higher-to-lower same-time correction, malformed/truncated writes, source outage,
  atomic replacement, rolling subset, unsupported version;
- metadata: matched, archived, forked, scheduled, missing identifier, unavailable,
  remote/SSH classification, first-install-after-cleanup;
- hierarchy: selected parent with children and exact parent/child token/tool/cost
  aggregates, fresh parent with old child records, missing parent, orphan, reappearing
  parent, cross-root replacement, cleanup-marker race;
- transcripts: partial output growth, cross-file duplicate, iterations, cache TTL
  variants, incomplete tail, truncation/replacement, source cleanup after capture;
- aggregate-only artifacts: supported `stats-cache.json`/`usage-data/` shapes only
  after separate privacy/format review, with explicit non-mixing and discrepancy tests;
- Claude retention settings: default/unset, user/project/local/managed precedence,
  `CLAUDE_CONFIG_DIR`, invalid/minimum/longer values, concurrent change, managed lock,
  and a privacy-preserving projection that exposes only `cleanupPeriodDays` plus its
  effective scope;
- durable ledger: parser bump with source present and absent, failed projection,
  mixed Codex/Claude rows with colliding timestamps/model-like keys, provider-only
  rebuild through the actual current refresh path, raw Claude identity/path/account
  canaries, one transcript message mapped to multiple provider requests/iterations,
  and before/inside/after-period purge followed by refresh while raw files remain; and
- optional OTel: duplicate delivery, absent request IDs, conflicting payload,
  event-versus-metric query-source categories, cumulative streaming frames, exhausted
  and recovered retries, absent intermediate retry events, missing client request ID,
  refusal/server fallback, third-party/non-streaming fallback, receiver outage,
  CLI/Cowork bleed, restart, and version/type drift.

### 0B. Source and cleanup model

Build a read-only hierarchical inventory prototype that:

1. reads Desktop metadata first;
2. selects a matching top-level global transcript by `cliSessionId` in memory;
3. traverses only the selected parent's bounded sibling session tree;
4. classifies new orphans without counting them;
5. captures root accessibility, enumeration completeness, and the Claude cleanup
   marker before and after discovery;
6. aborts or marks the generation partial if discovery races cleanup; and
7. does not age-filter a file that still exists.

### 0B.1 Optional Claude raw-transcript retention

Treat Claude's raw-file retention as a separate, optional resilience control—not as
Tibo accounting retention and never as a release prerequisite:

1. detect the effective `cleanupPeriodDays` and winning scope without retaining or
   logging unrelated settings values;
2. keep Claude's 30-day default as the privacy-first choice;
3. offer guided user-scope instructions for a 90-day opt-in as a reasonable recovery
   buffer, explicitly labelled as a Tibo recommendation rather than Anthropic's;
4. explain that Claude transcripts are plaintext and can contain file contents,
   command output, pasted text, tool calls/results, and related application data;
5. explain that increasing the value affects only future local cleanup, cannot restore
   deleted files, and does not alter Anthropic's server-retention policy; and
6. respect `CLAUDE_CONFIG_DIR`, higher-precedence project/local/managed values, invalid
   configuration, and a user's choice to keep 30 days.

The first beta should provide detection and guided instructions, not silently edit
Claude configuration. Any later one-click editor needs a separate gate: exact-key
merge into the user settings object, owner-only permissions, same-file/hash conflict
detection, no copied settings backup containing unrelated secrets, no overwrite of a
higher-precedence/managed value, and a clear confirmation before writing.

### 0C. Ledger and projection prototype

Implement the smallest content-free prototype that proves:

- a transcript candidate can become a logical winner;
- a later larger partial supersedes rather than adds to it;
- a selected source disappearing retains the winner and marks source/coverage state;
- a failed projection retains the last-good provider generation;
- the separate Claude namespace with colliding timestamp/model-like values produces
  provider-keyed reads and projections without collisions;
- Claude-only work leaves Codex rows and projections byte-for-byte and semantically
  unchanged, and the converse also holds. Claude calibration and replay-safe cache
  integration remain later production work. Mixed-provider collision
  tests remain a prototype guard for any future shared boundary, not a reason to
  migrate the Codex schema now;
- quota rolling replacement merges without removing old Tibo observations;
- a higher-to-lower same-time quota correction retains revision provenance while an
  unreadable/outage interval becomes unavailable rather than zero; and
- an explicit whole-provider or partial-period Claude purge is provider-isolated. The
  prototype proves fact deletion, winner recomputation, projection invalidation, and
  tombstoned re-import prevention. The new disabled shadow coordinator covers explicit
  cache/WAL/SHM/journal/backup/sidecar deletion with pre-delete partial receipts;
  installed production wiring remains later work.

Benchmark discovery, candidate canonicalization, merge, and projection independently.
Record wall time, peak RSS, bytes, source/candidate/winner counts, database growth, and
unchanged-refresh latency. The July 18-second/714-MB whole-history exporter result is
routing evidence, not acceptance.

### 0D. Optional exact-build OTel smoke

Do this only after explicit user approval for a trivial Claude request and without
exposing private content:

1. choose and record HTTP/protobuf or gRPC, then bind a temporary logs-only OTLP
   receiver to the matching explicit signal-specific loopback endpoint/path with a
   bounded body and no external headers;
2. configure logs as OTLP and explicitly set metrics and traces to `none`;
3. inspect relevant settings/environment scopes without persisting values, then
   configure Claude Desktop visibly and reversibly without overwriting existing or
   managed OTel settings; refuse if any exporter is non-loopback or content-bearing,
   warn/refuse for raw-body/file-mode flags, restore only when the configuration hash
   is unchanged, and disclose that Desktop/Claude settings can affect CLI, Cowork,
   local sessions, and preview servers rather than Code-tab sessions alone;
4. restart as required and record Desktop/embedded Code versions;
5. verify `service.name=claude-code-desktop`, request-level scalar token/cache/model
   fields, event-versus-metric query-source semantics, identity availability, and
   persistence-level absence of prompt/tool/body content, redacted content fields,
   path/identity fields, and host-authored MCP names;
6. test duplicate delivery, cumulative streaming frames, retry exhaustion/recovery,
   absent intermediate retry events/client IDs, refusal/server/provider fallbacks,
   receiver outage, Claude restart, CLI/Cowork bleed, port conflict, and re-enable; and
7. remove/restore only the configuration created for the smoke.

Treat runtime `>=2.1.214` only as the minimum containing the known cumulative-stream
double-count fix and client-request-ID support recorded in Anthropic's
[changelog](https://code.claude.com/docs/en/changelog). It does not establish durable
delivery, privacy, or correctness; only the exact-build receipt can do that. Stop the
OTel route if the exact build produces no request events, cannot avoid sensitive
fields before persistence, conflicts with managed/user settings, or cannot surface
delivery gaps.

### Phase 0 acceptance

- Every test in the red-team review's revised acceptance matrix passes.
- The exact SQLite/contract migration and deletion semantics are reviewed.
- No source disappearance or partial discovery can reduce accepted history.
- First-install and outage gaps are stored and rendered as unavailable, not zero.
- Provider-specific ledger reads, quota state, projections, and rebuilds are isolated;
  the separate Claude summary cache proves replay/correction isolation, while a
  production server/installed-app consumer remains a later gate.
- Retention detection reports the effective value/scope without leaking other settings;
  keeping 30 days works fully, and the 90-day path is explicit guidance only.
- Current-corpus benchmarks meet an agreed background-refresh budget.
- OTel remains optional unless its separate exact-build receipt passes.

## Phase 1 — authorization and production source inventory

Implement an owner-local source service that validates regular roots, does not follow
symlinks, and applies byte/file/runtime ceilings. Read only exact allowlisted
subpaths—Claude `projects/`, Desktop Code session metadata, and native quota history;
do not broadly scan authentication, plugins, or the rest of either root. A separate
retention probe may read settings sources only to project the effective
`cleanupPeriodDays` and scope; it must discard every unrelated value at the boundary.
Detect `CLAUDE_CONFIG_DIR`: support its allowlisted equivalents explicitly or report
an unsupported/inaccessible coverage state. Optional aggregate caches remain behind
their own privacy/format review. Use `cliSessionId` only in memory; persist only keyed
source/account/lineage identities and low-cardinality lifecycle diagnostics. Keep
Cowork and unrelated CLI sources out of the Code slice.

For direct Developer ID distribution, validate the two root anchors independently but
open only the allowlisted children:

```text
~/.claude
~/Library/Application Support/Claude
```

For a Mac App Store build, request two separate read-only security-scoped folder
bookmarks and prove them across relaunch/login and the bundled companion boundary.
Do not request the whole home folder. The initial Store scope excludes a loopback OTel
receiver unless network-listener/helper feasibility is separately approved.

### Phase 1 acceptance

- Parent/child inventory is bounded and deterministic.
- Inaccessible, `missing_suspected`, cleanup-paused/config-changed/manual-missing,
  evidence-backed expired, remote, orphaned, aggregate-only, and partial states are
  distinct. Missing alone never proves provider cleanup.
- Gap bounds use the last successful scan and next successful observation with stated
  confidence; they do not claim the exact time of unobserved activity.
- Non-first-party/API-key/Bedrock/Vertex/Foundry backends cannot enter the subscription
  slice without a reviewed detector and price/provenance contract.
- Raw **Claude** path/account/session values are rejected by provider-gated writes and
  absent from every table (including legacy identity tables), cache, journal/sidecar,
  backup, log, UI payload, diagnostic, and test snapshot.
- Revoked access does not erase facts or break Codex.

## Phase 2 — durable native quota history

Add the read-only `plan-usage-history.json` adapter with exact version/key validation,
owner/no-symlink checks, same-file-before/after validation, strict bounds, atomic-write
handling, keyed account scope, reviewed/unknown meters, source freshness, and nullable
reset evidence.

This is a standalone track. Native plan history is the authoritative passive quota
source; it does not depend on transcript ingestion, the pricing adapter, OTel, or a
shared Codex schema migration.

The current implementation merges each snapshot into a separate Claude quota-state
SQLite ledger and publishes a closed local-companion projection. Claude's 30-day
rollover removes nothing from accepted state. Account switches do not collide.
Revisions retain source generation/provenance and obey the reviewed rule. A later
installed-app integration may consume this provider projection without migrating the
Codex storage tables.

Do not derive a future reset from a five-hour/seven-day nominal window. A utilization
drop may be shown only as an inferred historical boundary with distinct provenance.
Sparse local-agent `rate_limit_info` remains out of scope until a separate exact-record
privacy review.

### Phase 2 acceptance

- Full replay, rolling replacement, account switch, higher-to-lower same-time
  correction, and malformed input produce deterministic results with revision
  provenance.
- App-off, inaccessible, and partial-read intervals produce bounded quota-coverage
  gaps rather than zero-filled samples or fabricated resets.
- Provider/account/meter/source revision participate in identity.
- Missing reset produces no countdown or reset notification.
- Quota-only change triggers no transcript rebuild.

## Phase 3 — durable transcript ingestion and pricing

Adapt the existing Claude canonicalizer to the metadata-selected hierarchical source
inventory. Preserve consistency checks, iterations, cache components, combined output,
tool classification, account attribution, and source provenance.

Write immutable candidates and transactional winner revisions into the durable ledger.
Tool aggregation and pricing projections consume winners only. Source truncation,
replacement, cleanup, or temporary inaccessibility must not erase accepted history.

Price through the existing event-time registry from the rich canonical winner boundary,
while preserving the validated model declaration, cache-write aggregate plus
five-minute/one-hour TTL split, and `provider_reported_combined` output kind. Unknown
models and missing or contradictory cache-TTL detail remain unpriced, not zero. The
strict
[Claude winner pricing adapter](../../src/claude-desktop-pricing.js) is independently
testable and exercised by the Claude prototype ledger/incremental path with a separate
replay-safe summary cache. The internal local-companion refresh has a programmatic,
disabled-by-default shadow call site, but no route, response field, setting, or
installed UI.
Pricing registry updates must rebuild derived values without rewriting token evidence.
This pricing track is independent of Phase 2 quota ingestion; neither lane may be used
as a substitute for the other.

### Phase 3 acceptance

- Full replay and every incremental/restart path select identical winners, totals,
  tools, and exact costs.
- Partial growth, copy across roots, and parent/child reconciliation preserve exact
  parent/child token, tool, and cost aggregates without double counting before and
  after parent cleanup, reappearance, or cross-root replacement.
- Parser upgrades behave honestly with both available and cleaned sources.
- Failed publication retains last-good Claude and Codex projections.
- Independent structural/ccusage comparisons differ only for documented semantics.

## Phase 3B — optional OTel continuity extension

Only after the Phase 0 OTel receipt passes, build a direct-distribution opt-in:

- loopback-only request-log receiver with a pinned protocol/path and body/rate limits;
- envelope handling that filters/discards unneeded records individually, durably
  commits accepted request records before ACK, fails only malformed/uncommitted
  batches, and exposes content-free dropped/unknown counts without logging payloads;
- strict field allowlist before persistence and no rejected-payload logs;
- append-only receive ledger with ingest ID, keyed HMAC of the canonical minimized
  payload, HMAC request/client/message/session identities, iteration/attempt ordinal,
  identity-strength grade, and conflict diagnostics;
- reconciliation with transcript request/message IDs into the same canonical ledger;
- distinct API-observed versus user-facing policies;
- visible configured/receiving/degraded/capture-started states;
- collector/Claude downtime gaps and transcript backfill while available; and
- conflict-aware restoration that never overwrites managed/existing OTel settings and
  disables only Tibo-created stale configuration after a crash/exit when the config
  hash still matches.

Do not use aggregate OTel metrics as canonical per-request history. Do not add
`subagent_completed.total_tokens` to request totals. Do not claim exact billing or
historical completeness. Do not use OTel as quota/reset evidence.

## Phase 4 — provider-aware product surfaces

Expose a provider collection rather than inferring provider from model/meter names.
For Claude show:

- observed five-hour, weekly, extra-usage, and reviewed scoped meters;
- exact observation time/freshness and “reset unavailable locally” where applicable;
- locally observed Code tokens by model/cache/output component;
- API-price equivalent with priced/unpriced coverage;
- capture start, retained-history horizon, known gaps, and source health; and
- a reminder that shared quota may include activity from unsupported Claude surfaces.

If a separately reviewed aggregate cache is used, render it as `aggregate_only` with
its own interval/provenance. Never splice it into the canonical event timeline or use
it to imply per-session completeness.

Add an optional Claude local-retention setup row showing the detected value and scope:

- **Keep 30 days** — privacy-first and fully supported;
- **Learn how to extend to 90 days** — guided, explicit opt-in for a larger recovery
  buffer; and
- **Managed or overridden** — identify the winning scope and do not offer a write that
  cannot take effect.

The copy must distinguish Claude's sensitive raw transcripts from Tibo's minimized
usage ledger and state that changing the setting cannot recover prior deletions.

Keep comparable quota rows in the menu-bar item with explicit provider labels. Use a
provider switch/distinct Claude view for dashboard history. Keep Code, Cowork, OTel API
totals, and transcript user-facing totals separate unless reconciliation proves the
chosen metric. Empty, unauthorized, stale, unsupported, partial, legacy, and purged
states must be actionable.

Add a clear local-retention explanation and a provider/period purge control. A
partial-period purge must split or recompute source lifecycle, winner revisions,
coverage gaps, manifests, and HMAC lineage without leaking or deleting outside the
selected interval; it invalidates all affected caches/sidecars/backups and may retain
only a content-free receipt plus the minimum scoped tombstone needed to prevent the
next scan from resurrecting data. The UI must say whether capture remains disabled or
when new post-purge data may resume. Make explicit that Tibo purge does not delete
Claude's raw files. Never imply that Claude's source cleanup also erased Tibo's
retained aggregate history.

## Phase 5 — privacy, performance, and release qualification

The release receipt must cover:

- source versions, hierarchy, replacement, cleanup, replay, correction, gaps, and
  account-switch fixtures;
- direct-build authorization and Store bookmark proof if Store is in scope;
- cold import, incremental update, unchanged refresh, peak RSS, database size, and UI
  response on small and real representative corpora;
- no credential/private-endpoint access and no Tibo-originated external egress;
- optional loopback OTLP separately disclosed if Phase 3B is included;
- raw Claude content/path/account/session/organization canaries across every table,
  legacy identity path, projection, cache, WAL/SHM/journal, log, diagnostic, UI, purge,
  backup, and error;
- exact pricing coverage and unknown model/cache behavior;
- provider-isolated Codex regression parity;
- launch, relaunch, login, sleep/wake, Claude update, cleanup race, and shutdown;
- retention-setting detection, precedence, keep-30, guided-90, managed/invalid/custom-
  config states, and proof that no unrelated settings value enters logs or storage; and
- English, Spanish, and Simplified Chinese visible strings.

Parser tests alone are not a release receipt. The installed Claude Code task, native
quota history, retained ledger, coverage UI, menu/dashboard, and source diagnostics
must agree on provenance, freshness, coverage, and internal projection semantics.
They are not expected to be numerically equal: account quota can include unsupported
Claude surfaces that have no local Code transcript.

## Effort and sequencing

Split the work rather than hiding OTel inside the beta estimate:

| Work | Focused engineering range |
|---|---:|
| Phase 0 fixtures, ledger/coverage prototype, lifecycle benchmark | 5–9 days |
| Claude namespace/source authorization and native quota adapter | 7–12 days |
| Durable transcript winner ledger and pricing projections | 7–12 days |
| Provider-aware menu/dashboard, retention/tombstone/purge UX | 5–8 days |
| Installed privacy/performance/regression qualification | 4–7 days |
| **Transcript/native-history direct beta total** | **28–48 focused engineering days** |
| Optional OTel exact-build spike and production extension | **+10–18 days after its gate** |
| Optional guided Claude 90-day retention UX | **+1–2 days** |
| Later automated conflict-safe settings editor | **+2–4 days after a separate write gate** |

Mac App Store authorization, SSH/remote support, Cowork, and an Enterprise Compliance
connector are separate gated extensions. These ranges assume the current direct-build
architecture, no migration surprise, and uninterrupted focused implementation. They
are neither likely calendar duration nor a Store estimate; discovery can widen them.

## Stop/go gates

1. **Durability:** accepted Claude facts survive source cleanup, missing roots, rolling
   quota history, and failed projections.
2. **Coverage:** first-install and outage gaps are explicit; absent never renders zero.
3. **Provider isolation:** every Claude fact/query/cache/projection is isolated in the
   separate Claude namespace, Codex remains unchanged, and any future shared boundary
   proves explicit provider identity plus the legacy-only NULL/empty -> `openai_codex`
   transition.
4. **Winner semantics:** logical-message revisions and parent/child lineage are
   idempotent across replay/replacement.
5. **Retention/privacy:** longer Tibo retention is disclosed; explicit purge and any
   selected automatic expiry are complete, tombstoned against re-import, and contain
   no raw Claude IDs/content.
6. **Claude raw retention:** 30 days remains the fully supported privacy-first default;
   a 90-day option is explicit guidance, cannot restore deleted history, and cannot be
   required for correct Tibo accounting.
7. **Quota honesty:** passive percentage-without-countdown is accepted; otherwise the
   product boundary must be reconsidered explicitly.
8. **OTel:** no production work until exact-build delivery, privacy, fault, and
   configuration tests pass; keep it out of initial Store scope.
9. **Release:** real installed-app evidence and a privacy/performance receipt precede
   any public support claim.

## Current next action

The highest-return Phase 0 preparation slice was implemented on 2026-08-16:

- minimized hash-manifested fixtures;
- hierarchical source inventory and cleanup-race detection;
- effective-retention detection with keep-30/guided-90 behavior and no settings write;
- native quota-history parser;
- a provider-isolated durable-ledger lifecycle prototype;
- a strict Claude pricing adapter, exercised by the prototype ledger/incremental path,
  that preserves model/TTL/combined-output semantics through a bounded replay-safe
  summary cache;
- the combined-output projection contract; and
- a selected-current-corpus benchmark.

See the [implementation receipt](../receipts/2026-08-16-claude-desktop-phase0-implementation-receipt.md)
and [ledger decision](../decisions/2026-08-16-claude-desktop-durable-ledger-decision.md).

The first performance pass is now implemented. A strict selective JSON parser validates
each complete row while retaining only accounting identity/usage/tool fields; the shared
bounded reader reuses its scratch allocation; candidates merge into SQLite in bounded
batches; SQL statements are reused; a content-free frozen-plan checkpoint reconstructs
against fresh private inventory paths; and candidate/cursor advancement commits
atomically across a forced ledger restart.

On the same 30-day selected corpus this reduced peak RSS from 1,938,341,888 to
517,439,488 bytes. The checkpoint plus already-parsed quota replay lane fell from
2,259.246 ms and 43,580 replayed candidates to 32.318 ms and zero candidate reads.
The full initial path still took about 29 seconds, including 13.837 seconds of global
canonicalization and 13.957 seconds of scan plus bounded merge. The serialized
content-free checkpoint was 18,770,474 bytes.

That global-plan blocker is now removed in the Phase 0 incremental prototype:

- each source retains only keyed identity, generation, prefix hash/line/byte cursor,
  and owner-only lifecycle state;
- unchanged sources use identity/size/mtime validation and read zero transcript bytes;
- an append verifies the previously accepted prefix and parses only its complete-line
  suffix;
- same-file mutation/truncation starts a new source generation and fails closed on
  conflicting logical-message invariants;
- canonical groups persist the existing exporter's exact winner, iteration, cache,
  model/session pseudonym, and unioned-tool semantics without raw paths or content;
- source rebuild generations flow into immutable provider-ledger candidate keys, while
  aggregate source-byte and canonical-record ceilings fail closed;
- dirty groups remain replayable until the provider ledger accepts them;
- interval expansion re-dirties newly covered preserved groups while end-time
  regression fails closed; and
- refreshes run in short-lived workers under the existing RSS watchdog.

The final isolated current-corpus receipt measured:

| Path | Wall time | Lifetime peak RSS | Transcript work |
|---|---:|---:|---|
| First import | 36.328 s | 534,249,472 bytes | 1,570,371,007 bytes / 298,156 lines |
| Fully unchanged refresh | 763.630 ms | 202,817,536 bytes | 0 bytes / 0 lines |

The unchanged path includes a fresh 97-record Desktop inventory, reopening both
databases, validating all 1,820 selected source files, rereading and deduplicating
13,273 quota observations, and deciding that no projection publication is needed. The
watchdog enforced 768 MiB for first import and 256 MiB for background refresh with no
sampling failures. The combined prototype databases occupy 333,643,776 bytes.

On 2026-08-17, the standalone native-quota track advanced through the production local
companion backend boundary. It now maintains a separate owner-only Claude quota-state
database and secret, refreshes concurrently and independently from Codex, and exposes a
closed `/api/local/claude/quota` projection that contains no source path, raw account
identifier, transcript content, or unknown-meter identity. Rolling empty, shorter, and
unknown-only snapshots cannot revive or present disappeared windows as current; exact
replay remains idempotent, while correction reversion remains a new revision. A live
two-pass read of the real native quota file imported 13,139 durable observations in
318 ms, then replayed them as 13,139 duplicates with zero inserts in 220 ms. This is
backend/route evidence only: the installed macOS menu-bar UI does not consume the route.

The pricing track also now persists the strict adapter's required model, billing-surface,
cache-TTL, total-input, event-time, and combined-output provenance in the standalone
prototype ledger. A bounded streaming summary and separate owner-only cache retain
aggregate coverage, warning codes, totals, and ordered digests without pricing rows.
Exact replay reuses the publication and a winner correction invalidates it. The
internal production refresh can now call it only through the explicit programmatic
shadow opt-in; its receipt is deliberately discarded at the loopback boundary, and
there is still no installed consumer.

Background suitability is now **passed for the truly unchanged path**. One-row append
correctness and zero-duplicate resume pass on privacy-safe fixtures, including exact
candidate parity with the frozen exporter and exactly one parsed suffix line. A
privacy-safe generated benchmark now covers first import, unchanged refresh, one-row
append, restart-after-append, and same-size prefix mutation. The original row-rich
debug pricing path failed at realistic scale: 10,000 rows exceeded 768 MiB and 35,000
rows exceeded 1.5 GB. After routing the benchmark through the bounded streaming
pricing summary/cache and streaming the ordinary usage projection with its exact legacy
array digest, 35,000 lines and 15,470,000 source bytes completed below the agreed
ceilings. First import peaked at 325,959,680 bytes; unchanged/restart at about 143 MB;
append at 145,948,672 bytes; and same-size mutation at 152,289,280 bytes. The synthetic
p99-size lifecycle therefore passes the 768-MiB bootstrap and 256-MiB background
budgets. No private real transcript was copied or mutated, bytes are not a complete
proxy for candidate density, and the 128,784,112-byte maximum observed source is not
represented.

User-facing production remains blocked on a database-footprint decision,
capture-window migration, backend/account attribution, installed-app
authorization/evidence, an installed quota-route consumer, and reviewed product
projection wiring. A broad Codex schema migration is not a prerequisite for this
provider-isolated first release.

The next-stage preparation now also includes an owner-only, local-only Claude shadow
controller and provenance namespace. The real local-companion refresh path contains a
programmatic opt-in, but it is disabled by default and creates no state until explicitly
enabled; there is no environment switch, route, response field, setting, UI, or upload
lane. It accepts only minimized usage candidates, excludes quota parsing entirely,
retains keyed digests/lifecycle metadata, and uses bounded timeout/backoff/cancellation.
Explicit purge retains the provider-ledger tombstone that prevents raw files from
resurrecting a deleted interval while deleting only rebuildable canonical/pricing
artifacts and provider-isolated shadow rows. Both stores and the physical inventory
are preflighted before mutation; partial purges split coverage gaps and preserve
surviving winner revisions. A closed readiness probe reports only
allowlisted usage-source availability and minimized retention status; missing quota
does not block the independent usage lane. This remains a shadow, not a user-facing
Claude support claim.

The preparation wave also freezes two standalone review contracts:

- a closed accounting/coverage envelope for capture start, app-off/pre-capture gaps,
  source cleanup versus user purge, opaque account attribution, retention horizon,
  pricing coverage, and combined-output display provenance; and
- a read-only, aggregate-only candidate-density/SQLite-composition census that emits
  counts, percentiles, byte totals, and fixed reviewed schema labels only—never paths,
  identifiers, content, or model strings.

The production-shaped incremental entrypoint now exposes the row-rich pricing
projection only as a debug opt-in capped at 5,000 winners. Ordinary and shadow
refreshes return the streaming bounded summary; an oversized debug request fails
before materializing rows or creating a pricing cache. The unrestricted lower-level
prototype reader is not a production call site.
Canonical dirty groups are acknowledged only after projection, pricing-cache, and
shadow publication all succeed, so a downstream failure replays idempotently instead
of stranding accepted usage.

The remaining Phase 0 review still requires:

- a database-footprint/compaction decision once the disabled shadow has accumulated a
  representative provider-ledger database;
- installed-app authorization, cancellation/progress, quota-menu consumption, and
  real shadow soak evidence before any user-facing enablement;
- backend/account-attribution and capture-window migration decisions; and
- optionally, a separately authorized exact-build OTel smoke receipt.

The adversarial automated matrix now covers source disappearance, usage-only quota
separation, downstream publication failure and replay, disabled/no-write behavior,
partial readiness, backoff, concurrent-operation refusal, cancellation, provider
rejection, path/content canaries, purge-then-reimport tombstones, parser-legacy
unpriced behavior, quota corrections/rollover, unsafe-store purge preflight, exact gap
splitting, revision preservation, cooperative and non-cooperative readiness deadlines,
custom Claude/project roots, and loopback privacy. These are focused
repository receipts, not installed-app acceptance.

The optimized read-only density census completed over the current local source set
after replacing repeated whole-plan validation with the existing one-time bulk plan
slice. It selected 1,471 of 1,476 JSONL files, read 1,377,321,447 source bytes, and
counted 43,812 candidates without writing durable artifacts. Candidates per selected
source were p50 8, p90 65, p95 108.5, p99 258.9, and maximum 5,371; 557 selected
sources had zero candidates in the measured interval. SQLite composition remains a
separate fixed-label read-only tool until a representative shadow database exists.

Do not begin user-facing Claude product work until those artifacts pass review.
