---
title: Thread and project usage red-team review
date: 2026-09-08
type: review
status: reviewed
---

# Thread and project usage red-team review

Review of the [design spec](../design/2026-09-08-thread-project-usage.md), with
three Luna passes covering local products, observability products and independent
design critique, plus a completed user-authorized ChatGPT Pro consultation.
This is design work only. No product implementation, migration or installation
was performed. Repository grouping with worktree detail remains owner-approved.

## Verdict

The feature is useful, and comparable tools establish that ranked session and
workspace usage is a familiar pattern. Reuse TiboTattle's accounting; borrow the
navigation and comparison patterns. Do not import another collector, replace
the ledger, infer semantic tasks from conversations, or equate token share with
subscription cost. Amend the design before implementation: v1 includes both
repositories and individual threads, with worktree drill-down, stable report
snapshots, exact thread lookup and explicit completeness. Defer worker-family
grouping and historical repository reconstruction. The linked spec incorporates
these recommendations; this review does not qualify the future implementation.

The highest-priority gates are shared per-event arithmetic, preservation of
unknown facts, and a scope-safe event attribution port. Reusing a component
requires verifying its semantics, not assuming every legacy adapter is suitable.

## Verified comparable examples

Sources inspected on 2026-09-08. These are official documentation and source
observations, not runtime or installed-product qualification. Product behavior
can drift after this review. Recommendations in the final column are our judgment.

| Example | What is verified | Transfer to TiboTattle |
|---|---|---|
| [Tokscale workspace grouping](https://github.com/junhoyeo/tokscale) | Workspace/model grouping, a worktree-to-repository toggle, separate workspace keys and labels, and Unknown workspace. Its README acknowledges string-identity and symlink limits. | Closest match to the requested repository/worktree view. Keep reversible grouping, unknown rows and conserved totals; avoid path-shape guesses or treating string equality as historical identity. |
| [ccusage session reports](https://ccusage.com/guide/session-reports) | Per-session tables with token/cache buckets, estimated cost, model breakdown, last activity, exact session-ID lookup and date filtering before aggregation. | Add exact thread lookup and recent-activity sorting; make cache composition discoverable. Keep TiboTattle's own accounting and interval semantics. |
| [ccusage Codex adapter](https://ccusage.com/guide/codex/) | Reads active and archived local logs and reconstructs deltas; documents replay handling and source-specific fallbacks. Calls its cost an API-equivalent estimate. | Reconcile identities and replay with the canonical source; do not adopt legacy model/config fallbacks as historical evidence. The docs contain both skipping and fallback language for missing models, so no universal claim is made here. |
| [Claude Code usage](https://code.claude.com/docs/en/costs#using-the-usage-command) | Current-session token and local price estimates, cache reporting, separate plan bars and local usage attribution. Docs distinguish the price estimate from subscription billing. | Clear metric labels and local-device scope. Do not copy plan percentages into project totals or assume all agent activity shares the same cache denominator. |
| [Langfuse sessions](https://langfuse.com/docs/observability/features/sessions) | Propagated session IDs group observations/traces; session detail supports inspection, replay and annotations. | Use explicit grouping identity and overview-to-detail navigation. Conversation replay and public sharing are outside this feature's boundary. |
| [LangSmith threads](https://docs.langchain.com/langsmith/threads) | Groups traces by thread metadata; explicitly requires metadata on child runs for their tokens/costs to be included. Details keep thread context while inspecting children. | Strong evidence for a whole-family attribution contract and keeping the selected thread context visible during drill-down. |
| [Helicone sessions](https://docs.helicone.ai/features/sessions) | Explicit session IDs and hierarchical paths organize multiple requests into a workflow. | Hierarchy is useful when supported by explicit relationships. Do not infer worker ancestry from timestamp adjacency or directory similarity. |

Langfuse explicitly requires non-overlapping token buckets: inclusive provider
counts must be normalized before summing cache/output details. This is a useful
comparison for TiboTattle's combined-output and cache component contracts, not
evidence that arbitrary trace parent/child totals are automatically deduplicated.
[Token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking#usage-types-are-mutually-exclusive-buckets).

Tokscale's optional task report sends unsummarized sessions to the selected LLM
backend. That is a separate capability and should not be confused with its
numeric workspace summaries. TiboTattle can answer this request from usage and
context metadata without adding content-based task classification.
[Tokscale report workflow](https://github.com/junhoyeo/tokscale).

## Findings and disposition

### RT-01 — P1: current paths cannot prove historical repository ownership

Trigger: repository A occupied a working directory last month; it is moved away
and repository B is initialized at the same location. A current Git lookup gives
B's common directory for A's historical usage. Hashing the path changes neither
the ambiguity nor the result. Re-resolving membership on each generation can
silently move historical totals between projects.

Evidence: a synthetic local experiment initialized a repository, moved the whole
directory, then initialized another at the original path. The common-directory
strings were equal and the directory identities differed. Git documents
worktree moves, removal and repairs; its current common-directory lookup is not
a historical identity service. [Git worktree](https://git-scm.com/docs/git-worktree),
[Git rev-parse](https://git-scm.com/docs/git-rev-parse).

Amended: distinguish recorded working context from repository associations
resolved later. Store versioned observations with method/time; pin each report's
mapping. A later correction may regroup historical workspace usage on explicit
refresh, while preserving earlier observations. Missing paths retain last-observed
bindings with stale qualification where available. V1 offers last-observed
location grouping, not verified historical ownership. Permanently freezing a
backfill guess would not establish its historical truth.

### RT-02 — P1: visible-page worker grouping cannot produce correct rankings

Trigger: a parent is on page one and its highest-usage worker is on page three;
or only workers were active in the selected period. Grouping after pagination
creates different totals depending on page size and can omit the group entirely.
An indirect worker chain also exceeds the existing one-parent display lookup.

Amended: derive permitted ancestry closure across the filtered population before
ranking and paging. Ancestors outside the time window may be headings, never
extra usage. Project/account filters remain event filters and cannot import
out-of-scope worker usage. Cycles and unresolved links stay explicit. Test the
same result with several page sizes, inactive parents and cross-project workers.
Defer this feature beyond v1. The current reader has no revisioned graph; the
later implementation must freeze ancestry independently from optional labels.

### RT-03 — P1: null-to-zero projection can hide incomplete evidence

Trigger: a fact has no known token components. The existing UI adapter turns
null into zero, then `usageProjection` returns null. Deriving coverage solely
from resulting rows can claim complete coverage or no activity. Another case:
combined output is present with only part of its split; current precedence can
discard the combined count. This review establishes the code path, not the
frequency of such facts in user data.

Source: pinned `origin/main` at
`dffe64d60c3ea6de985c697c31678bdf22feb815`,
`src/local-unified-companion-source.js` (`recordShape`, `tokenCount`) and
`src/local-companion-usage-model.js` (`usageProjection`, `addComponents`).

Amended: capture component/source completeness before compatibility coercion;
keep unknown-only fact counts. Use `Recorded tokens · partial data` by default.
Only qualified, non-overlapping positive facts justify lower-bound language.
Any arithmetic correction belongs in the shared owner with parity tests. Output
representation must be chosen per event: a 100-token combined event and a
20-text/5-reasoning event sum to 125. This is an acceptance counterexample, not
a claim that every existing aggregation path currently produces 25. Distinguish
a known total with incomplete breakdown from an unknown total.

### RT-04 — P1: active ingestion can make pagination unusable

Trigger: a new publication arrives while a user reads page four. The original
reset-on-generation-change rule repeatedly returns them to page one, while
detail may require data from an already-replaced publication.

Amended: retain a bounded immutable browsing snapshot and offer `New usage
available`; explicit refresh/filter changes begin a new snapshot. Enforce idle
expiry and memory/concurrency limits. Scope changes still invalidate handles
immediately. Expired detail must say so rather than mix old totals with new data.

### RT-05 — P2: counts and shares need independent denominators

Trigger: one thread works in two repositories. Summing project thread counts
overstates the number of threads. Similarly, 100% of known tokens assigned to
projects says nothing about unknown-size or missing events.

Amended: distinct active thread counts across the selected population; project
counts exclude Unassigned. Keep known-token attribution share separate from
facts with missing usage and source coverage. Every drill-down names its own
denominator. Sorting partial totals is by recorded amount, not proven actual rank.

### RT-06 — P2: friendly names and discovery are a product tradeoff

Trigger: names disappear after source rotation, or a user needs a low-usage
thread among thousands of rows. Page-only transient enrichment is privacy-safe
but neither a global search index nor durable labeling.

Recommendation: exact thread-ID/approved Codex-link lookup and recent-activity
sorting in v1, plus project/model filters that use typed data. Never call a
search of one rendered page a history search. Make label-unavailable state
distinct from missing identity. User-authored local aliases are a separate
future privacy/storage decision, not an implicit requirement to persist names.

### RT-07 — P2: total tokens can be mistaken for financial impact

Trigger: a cache-heavy thread ranks above a lower-token thread with expensive
uncached input/output. The ranking answers token volume, not billable impact.

Recommendation: retain total tokens as the user's requested default; expose
cache/uncached/output composition and a clearly labeled API-equivalent option.
Missing-price rows remain visible, qualified and included in token totals.
No subscription-cost allocation or per-project quota estimate is justified.
Sum exact decimal prices before presentation rounding, preserve null/status
instead of treating an unavailable legacy numeric zero as free, and qualify cost
when token counts are incomplete even if all known components are priced.

### RT-08 — P2: expensive query work needs a lifecycle, not just batching

Trigger: multiple tabs/filter changes start scans and metadata passes at once;
bounded per-batch memory still permits unbounded group maps, jobs or snapshots.

Amended: one aggregation job per local app session, coalesced identical
requests, bounded queue/snapshots, preparing/progress/cancel states and cleanup
of temporary grouping on failure. Reuse existing background-task primitives.
Measure cold/warm latency and high-cardinality memory before adding persisted
rollups; proposed performance targets are not measured results.

### RT-09 — P1: the current accounting stream is not a complete reporting port

The pinned `src/local-unified-accounting-source.js` stream selects event/thread
fields internally but its base DTO omits event key, thread identity and account
scope; it also skips facts without usable components before calling consumers.
Optional attribution enrichment must be audited separately. Its upper time bound
is inclusive, while this design specifies a half-open interval.

Amended: an owner-controlled internal port preserves canonical identities,
nullable facts, source order and scope. Qualify thread keys by provider/account,
keep unknown-account facts separate, and normalize interval bounds explicitly.
Do not patch missing identities through filenames or label enrichment. Verify
boundary inclusion and reconciliation with the same resolved dashboard interval.

### RT-10 — P1: a metadata join must neither multiply facts nor wait forever

A thread can change working context; the same source can be replaced; two
overlapping context segments can match one canonical fact. Joining by thread or
timestamp alone can misassign or duplicate usage despite a correct ledger.

Amended: join generation/scope/physical-source instance and source record order;
validate zero-or-one matching context segment and reject overlap before
publication. Missing source order/context stays Unassigned. Distinguish a
completed traversal with partial coverage from interrupted processing: missing
historical sources must not leave the project page permanently preparing.

### RT-11 — P1: individually valid responses can form a misleading page

Current thread cards above stale project rows create incompatible denominators.
Likewise, summary metadata from a new scope must not enrich an old snapshot.

Amended: replace cards, denominators, rows and detail as one coherent numeric
bundle. Bind handles to authorized scope and invalidate them on scope changes.
Carry over the concrete local route header, Origin and Host checks before any
data work, with no-store responses and negative authorization tests. Local-only
placement alone does not establish these protections.

## Independent synthesis and decisions

[ChatGPT Pro consultation](https://chatgpt.com/c/6aa07654-0360-83e8-b514-00eda7c3af1d)
was completed through the visible ChatGPT web UI with Pro selected and verified.
It received a sanitized design brief, without conversation content, credentials
or user usage records. Its findings are model judgment based on that brief, not
an independent source inspection or benchmark. The local Luna design pass and
parent-agent source checks supply the implementation evidence described above.

Accepted: both repository and thread views in v1; worktree drill-down; per-event
shared arithmetic; unknown-only rows; stable snapshots; explicit scope, price
and attribution coverage; exact-ID lookup; deferred worker families. The Pro
review reinforced that labels must never determine identity or ordering.

Two stronger proposals were narrowed on review. An immutable historical Git
registry is unnecessary for an honestly labeled location-based first version;
versioned observations preserve reproducibility without pretending to recover
lost history. Similarly, incomplete metadata coverage does not itself prevent
publication after a successful bounded traversal. These distinctions keep the
feature useful without weakening its claims.

Build decision: extend the existing reporting/index/UI owners; borrow established
interaction patterns. Do not wrap a competing collector: that would introduce
another interpretation of the same usage facts. Re-evaluate only if the existing
authority cannot provide the required contracts after qualification.

## Validation and remaining limits

The spec now includes the findings and concrete synthetic acceptance fixtures.
Focused documentation links, frontmatter and whitespace are checked separately
from product tests. No feature code or schema migration was made. Competitors
were inspected through primary docs/source, not installed or benchmarked. The
synthetic mock predates these amendments and still illustrates later worker
grouping; it does not demonstrate the newly specified failure states.

Implementation must first reconcile the actual branch with the pinned newer
source, qualify the shared contracts and record the expanded local metadata
boundary. Performance targets, provider metadata completeness and installed-shell
behavior remain unverified. The prior repository-wide preflight blockage is
documented in the spec and was not repaired as part of this design review.
