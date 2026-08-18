---
title: Draft update for Windows compatibility issue 3
date: 2026-08-17
type: plan
status: ready-for-review-do-not-post
---

# Draft update for Windows compatibility issue 3

This draft is complete for maintainer review. Do not post it without separate
authorization.

## Proposed issue comment

Completed a bounded four-engineering-day Windows-readiness milestone. This is
portable-core evidence, not Windows support or a release candidate.

What landed in the candidate branch:

- An explicit, reviewed portable-test manifest covering shared contracts,
  accounting/analysis, provider/privacy, storage/companion, and web behavior.
- A source-controlled ledger that fails when a `win32` branch is added or
  changed without a classification and follow-up.
- A pinned Debian Bookworm container that runs the lane without network access.
- A manual native Windows x64 workflow with pinned actions, locked dependencies,
  read-only permissions, environment receipts, and tracked-file cleanliness.
- Native/cross-host Windows path contracts plus a real child-process companion
  smoke using synthetic Codex data.
- A hash-pinned, disposable Credential Manager write/read/delete probe. The
  production Windows credential backend remains intentionally unimplemented.
- A concrete Windows ACL, reparse-point, hard-link, and handle-identity security
  contract for the later production-storage milestone.

Qualification on the same revision:

- macOS arm64 portable lane: 932 tests; 930 passed, 0 failed, 2 native-only skips.
- Network-isolated Linux container: 932 successful test results with the same
  two native-only skips; image
  `sha256:68dd7062098166f1055c60e3994ca1e78041d9d6860570ac9846eedd8611edf7`.
- Native Windows x64, normal cache: 910 tests; 904 passed, 0 failed, 6 explained
  skips; job `95387488689` in
  [run 32029951441](https://github.com/adamallcock/tibotattle/actions/runs/32029951441).
- Native Windows x64, clean cache: the same 910/904/0/6 result; job
  `95387488776` in the same run.
- Credential Manager probe and cleanup: passed in both native jobs; audited
  binding SHA-256
  `b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc`;
  deletion and absence confirmed.

The production client remains macOS-only. Still open in this issue are the
desktop shell, all four production Credential Manager capabilities,
adversarial filesystem security, provider-source acceptance, installer choice,
signing, clean install, upgrade/failure recovery, uninstall, and installed
artifact QA.
