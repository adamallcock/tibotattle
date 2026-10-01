---
title: Contribution reliability repair and release handoff
date: 2026-09-22
type: plan
status: source-qualified
---

# Acceptance boundary

Repair the confirmed contribution failure paths from the September 22
investigation and deliver reviewable commits to the separate 0.1.24 release
task. Base: release candidate `60b9cf5209792811e6914497587bd098c5fcefaa`,
including its v1.2 transport; this task does not publish or deploy.

## Work and ownership

- Transport: classify transient HTTP/stream failures as retryable across
  enrollment and supported transports, preserving closed success/auth contracts.
- Startup: use trustworthy index/projection age so repeated short sessions
  cannot indefinitely suppress detailed ingestion.
- Scheduler/composition: coalesce new-generation upload requests, preserve
  backoff, revocation and opt-out, and expose bounded local diagnostic facts.
- Operations: aggregate-only queries separating receipt, activation, projection
  and public publication; no participant identifiers or private payloads.
- Integration: meaningful cross-boundary regressions, focused and owning-surface
  tests, privacy/dependency checks, review, then exact-commit release handoff.

## Required regression evidence

HTML 503 and 429 retry; malformed success and revoked credentials do not become
authorized. Stream interruption stays bounded. Refresh-triggered upload cannot
override a retry deadline or terminal authorization state. Rapid publications
coalesce and never overlap uploads. Failed/cancelled/unchanged/quick refreshes do
not claim new index publication. Stale startup performs detailed ingestion;
recent successful evidence keeps cheap startup. Diagnostic fields are explicitly
allowlisted and contain no raw errors, identifiers, source paths or payloads.

Installed-artifact/native release qualification remains with the release task.
Source tests are not release proof. Production cohort measurement needs an
authorized read-only connection; a query artifact is not a live measurement.

## Implementation and regression protection

- Electron evaluates trusted unified-index publication freshness after startup
  barriers clear. Recent matching evidence permits quick work; one-hour-old,
  missing, malformed, future or mismatched evidence requests detailed ingestion.
- Successful complete changed-index publication wakes accountless contribution
  after the snapshot reload. Notifications coalesce into one pass within 60
  seconds, preserving earlier work, server Retry-After, opt-out and terminal
  authorization states. Cancellation during reload cannot become success.
- Enrollment and v1/v1.1/v1.2 treat temporary gateway responses and interrupted
  streams as transient while preserving closed acknowledgement/auth contracts.
  Envelope-key failures retain their transport classification through adapters.
- Performance transport receives the same protection. Persisted transient
  `retry_exhausted` stops recover; explicit opt-out, revocation, invalid responses
  and local invalid-data pauses remain terminal. Pending retry deadlines stay
  retries instead of accidentally turning into permanent pauses.
  Successful earlier days preserve the persisted retry count until the whole
  bounded backfill pass succeeds; scheduler restarts cannot reset that backoff.
- The local contribution support route and Copy diagnostics expose six closed
  scheduler facts. Bounded private fixed-code notes retain an incident trail
  across restart; live timestamps explicitly describe the current process.
- The maintained [completion-funnel runbook](../runbooks/2026-09-22-contribution-completion-funnel.md)
  and synthetic-tested SELECT-plan tool separate receipt, source activation,
  projection and publication. They do not issue database requests.

Permanent regression lanes include root `test/*.test.js`, local
`apps/local/*.test.mjs`, web `apps/web/test/*.test.mjs`, and the Worker's
`scripts:check`. Tests exercise actual controller-to-scheduler composition,
transport boundaries, interrupted responses, malformed success, revocation,
Retry-After, repeated short launches and diagnostic privacy. No tests use real
private source data or live contribution writes.

## Release and operational handoff

The separate 0.1.24 release task owns integration, the combined root/Worker gates,
exact packaged/native qualification and publication. Avoid concurrent full gates
against its active release work. Its packaged check must cover an old index at
launch, repeated refresh completion through the actual preload boundary, an
accepted upload after index advancement, and the preserved opt-out/retry paths.
These source tests cannot prove that installed behavior.

After publication, compare aggregate receipt cohorts and observed activity days
separately. Confirm current-day source activation, projection and publication
progress, rather than treating a nonzero upload count or an empty daily queue as
proof of recovery. Direct production cohort measurement remains unavailable in
this task without the operational connection; no population-wide recovered-count
claim is made. No remote writes, releases, migrations or implicit fleet telemetry
were introduced.

## Validation receipt — 2026-09-22

Source base: `60b9cf5209792811e6914497587bd098c5fcefaa`; branch
`codex/contribution-reliability`. All fixtures are synthetic.

| Gate | Result |
|---|---|
| Enrollment, v1/v1.1/v1.2 and performance transport; accountless/social composition, ten serial test files | 162 passed |
| Scheduler, actual refresh-to-upload composition and private diagnostic recorder | 46 passed |
| Final refresh controller, publication composition and private diagnostic recorder after cancellation/unknown-change fencing | 122 passed |
| `pnpm run product:local:test` | 397 passed; subsequent focused refresh/performance tests cover final refinements |
| `pnpm run product:ui:test` | 1,037 passed |
| Final accountless runtime, production loopback profile and social performance tests | 11 passed |
| Completion funnel synthetic SQLite contracts/aggregates | 5 passed |
| `pnpm run test:preflight` | 20 passed, including root layout and documentation governance |
| `pnpm run docs:check`, `pnpm run architecture:check`, `git diff --check` | Passed |

Counts overlap across suites and must not be summed as distinct tests. Independent
review identified and then rechecked the mixed-day backoff reset and permanent
capability-status classification defects. Both have regressions. The same review
checked publication cancellation, timer coalescing, diagnostic allowlists and
aggregate query limitations. The combined root/Worker and packaged gates remain
explicit release-owner work on the integrated candidate, not omitted evidence
presented as a pass.
