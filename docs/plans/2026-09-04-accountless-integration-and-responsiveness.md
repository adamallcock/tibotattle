---
title: Accountless contribution integration and desktop responsiveness
date: 2026-09-04
type: plan
status: in-progress
---

# Scope and acceptance

## Current implementation boundary, 2026-09-05

This work is unfinished. The new client, scheduler and inherited process
channel are limited to an explicitly injected, disposable IPv4 loopback
laboratory. The normal Electron launcher still removes hosted contribution
origins and reports uploads unavailable. The protected credential adapter has
synthetic storage tests but is not activated in the normal desktop runtime.

Automatic review rejected hosted runtime wiring and a broad database rebuild.
No remote service, database, real credential or real contribution was changed.
The corrected [migration review](../reviews/2026-09-05-accountless-migration-proposal.md)
withdraws the incomplete earlier design and describes the required preservation
contract. Source migration and disposable D1 rehearsal approval remain pending.
The Worker ownership contract is implemented and tested but is not routed;
client-to-Worker upload, server deduplication and usage/quota ownership cannot
yet be described as end-to-end qualified.

## Intended completed behavior

Continue `codex/unified-desktop-accountless` from `dc93b273`. Finish the
accepted [sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md)
through enrollment, versioned upload permission, the existing incremental
telemetry pipeline, and bounded while-open scheduling. Preserve legacy native
consent, durable opt-out, source privacy, account linkage and replay safety.

The desktop owns the preference and OS-protected installation secret. The
companion owns index projection and uploading. A closed parent-child process
channel conveys current authorization and credential operations; no new
renderer or loopback credential capability is introduced. Every network step
checks current authorization. Opt-out fences pending work immediately, is
persisted before success, and cancels the active pass. Restart re-evaluates
saved policy instead of inheriting a transient permission.

Use the existing upload envelope, quota/usage projection, duplicate handling,
and backend admission budgets. Accountless records remain excluded from public
fit until an independent eligibility decision. No fabricated social session
or explicit-consent event may authorize automatic sharing.

## Work and evidence

- Terra Max: authenticated backend ownership and upload authorization, legacy
  isolation, revocation/expiry/replay tests in a disposable Worker laboratory.
- Terra Max: client enrollment and guarded incremental upload reuse, bounded
  errors, cancellation, retry and privacy tests.
- Terra Max: investigate the preserved 471/582 ms response failures, measurement
  semantics and major hot paths before proposing a budget change.
- Integrator: desktop/companion scheduling and protected credential wiring,
  synthetic end-to-end test, UI status, focused then cross-surface validation.

Required synthetic cases: fresh automatic sharing; existing pending notices;
opt-out before and during enrollment/upload; re-enable; restart; duplicate
delivery; service rejection/offline/retry; revoked/expired permission; malformed
or cross-installation upload; usage/quota association under one installation.

Preserve both old performance failures. Measure the same workload after fixes;
separate cold initialization, idle status, and active-refresh responsiveness.
A budget change must explain the user experience and observed latency, rather
than relabel an earlier failed run.

Local development and synthetic upload tests are authorized. Production or
staging deployment, remote migrations, real-account uploads, signing and public
activation remain separate gates. Local-QA profiles retain zero hosted egress
and no real credential mutation. Physical credential/runtime qualification on
each OS is separate from source and package validation.

## Validation so far

- The client reuses the v1.1 projection/encryption/cursor engine with a distinct
  policy authorization; synthetic tests cover enrollment and ownership receipt
  validation, changing preferences, cancellation, bounded retry and terminal
  expiry/revocation. These use synthetic transport responses, not an integrated
  Worker database.
- Scheduler and actual owned-child tests cover fresh default-on, persistent
  opt-out and restart, unavailable/pending-notice refusal, coalescing, shutdown,
  late responses and credential-write acknowledgement. Opt-out is saved before
  success and waits for child cancellation acknowledgement; requests already
  dispatched can still have reached a server. Partial results show remaining
  work instead of claiming that sharing is up to date.
- A final review found and fixed a lost credential-mutation acknowledgement
  race. An uncertain write now retains the public installation binding;
  restart reuses a completed protected write without a second create, or fails
  closed if no credential was saved. Timeout/recovery, timeout/fail-closed and
  disconnect regressions pass with the capability suite (34/34). These are
  synthetic local tests, not OS credential or Worker ownership qualification.
- The broad Electron, web and local companion suites passed before the final
  lifecycle refinements; the affected lifecycle/UI tests also pass. The full
  root suite was not green: export-list expectations were corrected and
  rechecked, and its portable companion test passed with loopback binding
  allowed. Retained R7 provenance and existing release-history/tag mismatches
  remain separate unresolved gates; no evidence was regenerated to hide them.
- Terra's deeper performance review identified a duplicate quick-mode snapshot
  build and unused overview copies. A successful progress publication now avoids
  the redundant terminal quick build; failed progress publication still gets a
  terminal retry, and detailed refresh still publishes quick then full. Refresh
  orchestration can publish without requesting an unused overview copy, while
  ordinary accessors keep their detached return values and retention semantics.
  The affected datastore suites pass 68/68 and the complete local companion
  suite passes 313/313 after these changes.
- Worker ownership request/receipt contract tests and Worker typecheck pass.
  There is no executable ownership migration and no real-Worker upload receipt.
- [UI status QA](../qa/2026-09-05-accountless-status-qa.md) verifies the closed
  Community/Settings state mappings and 12 synthetic headless-browser captures.
  Active/off text, switch state and message overflow checks pass. Root also
  inspected representative Community and Settings images. These are browser
  fixtures; packaged Electron, keyboard and assistive-technology qualification
  remain open.
- [Responsiveness research](../research/2026-09-05-electron-real-history-control-plane-measurement.md)
  preserves both earlier failures and repairs the undersampled combined p95.
  New samples separate warm-up and active responses per endpoint. The 250 ms
  active p95 budget remains unchanged. The corrected isolated optimized
  candidate `07e639d386a57d70a2063371506eacd1d8de6215` passed the targeted
  cancel-mode run: health p95 208 ms, refresh-status p95 207 ms, maximum 364 ms.
  It sampled four active rounds before quick publication and sixteen at or
  after it; cancellation, retry and clean quit passed. The earlier post-quick
  1 ms result and failed sequencing receipt remain preserved. This is one
  copied-profile macOS arm64 candidate, not a full/terminal projection or
  integrated accountless qualification.
- The completed performance changes and final QA hardening were committed and
  pushed as `f71d121dfc4c94572679fcc1a5ab940b0197dc04` using the existing branch
  push/CI approval. [Four-target development packaging run 33953598844](https://github.com/adamallcock/tibotattle/actions/runs/33953598844)
  passed all four jobs, including the Windows native binding and packaging
  checks. Four unexpired commit-named artifacts were verified through the
  Actions API. This commit contains seven performance/QA files; the
  accountless prototype and migration proposal remain local and uncommitted.

## Remaining completion gates

1. Approve the reviewed source migration and synthetic local D1 rehearsal;
   implement direct accountless ownership with truthful nullable social fields
   and verify preservation of all existing social data and admission semantics.
2. Run the actual Worker enrollment-to-encrypted-v1.1 flow, duplicate replay,
   usage/quota linkage, revoked/expired credentials, opt-out and retry cases.
3. Complete review of the exact hosted destination and allowlisted payload
   before enabling the normal desktop transport. Deployment and remote migration
   still need their own authorization.
4. Qualify the real OS credential adapters, rendered controls and updated
   artifacts on the four target platforms. Synthetic crypto and a Mac package
   do not establish those platform gates.
