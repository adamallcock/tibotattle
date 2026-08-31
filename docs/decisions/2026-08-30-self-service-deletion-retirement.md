---
title: Retire self-service hosted deletion
date: 2026-08-30
type: decision
status: accepted
---

# Retire self-service hosted deletion

## Decision and scope

The owner approved retiring self-service hosted account deletion on 2026-08-30.
Remove the participant deletion endpoint, dashboard controls, client methods,
translations, and documentation promises. Preserve device disconnect, local
data erasure, hosted export, private owner-operated erasure, and deletion-safe
restore replay. This is not a decision that pseudonymous data is anonymous or
that applicable erasure requests may be ignored.

Implementation starts from `b711221742a6be781ee38b131bdb5d339f8f3f65`.
Source implementation, local tests, app release, and hosted deployment are
separate gates. No production deletion or deployment is authorized by this work.

## Contract

- `DELETE /api/v1/me` becomes an unknown API route (`404 NOT_FOUND`), without
  reading or mutating participant state. Previously retired per-contribution
  deletion stays retired. Health reports `participantDeletion: false` and keeps
  `deletionSafeRestoreReplay: true`.
- The dashboard offers **Disconnect this Mac**, with explicit confirmation,
  through the existing local device-disconnect contract. It stops this device's
  delivery without deleting hosted history or local analysis. Signing out is
  not a substitute for disconnecting the device.
- Private erasure uses the existing owner-only `POST /api/v1/admin/action`
  maintenance boundary. An explicit `participantErasure` object contains the
  exact opaque `participantId` and `confirmation: "erase_hosted_participant"`.
  Ordinary maintenance without that object never starts participant erasure.
- The maintenance audit identifies `task: "participant_erasure"` and a
  purpose-separated participant digest, not raw identities or contribution
  contents. Existing Access owner-pinning and CSRF protections remain required.
- Owner erasure preserves the upload fence, aggregate withdrawal, independently
  verified tombstone, identity cooldown, R2 cleanup, and final database removal.
  It can resume an already-deleting participant without a live participant
  session. A missing participant is reported already erased only when the
  independent deletion ledger proves it. Failures never claim completion.
- Owner retries use an audited UUID fence. Restore replay owns the separate
  `NULL` fence and cannot finalize or take over an in-flight owner operation;
  owner erasure likewise cannot take over an interrupted restore replay.
- No migration, table removal, retention-window change, or removal of old
  tombstones is needed. Existing restore, reconciliation, expiry, cascade, and
  aggregate safeguards remain in service and under test.
- Current docs stop advertising self-service deletion. Accurate privacy,
  retention, rights-request, owner-operation, and restore instructions remain.
  Retained historical evidence is not rewritten to imply a different past.

## Implementation and verification

- [x] Retire the public route and extract owner erasure behind maintenance auth.
- [x] Prove public deletion refusal has no account/storage side effects.
- [x] Prove private authorization, confirmation, retry, partial failure,
  cooldown, aggregate withdrawal, and restore behavior.
- [x] Remove the deletion UI/client/translations and expose device disconnect.
- [x] Update maintained docs, privacy disclosures, and agent instructions.
- [x] Run focused tests, broader owning gates, documentation checks, and real
  rendered-browser verification. Record limitations without implying deployment.

## Test run report

### Scope

Validation covers Worker routes/storage, local upload scheduling and relay,
browser controls/localization, local HTTP fixtures, and maintained docs. It
does not exercise production data, real sign-in, the user's Keychain, an
installed native build, release signing, or deployment.

### Results summary

| Check | Tests | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: | --- |
| Root `npm test` | 3140 | 3117 | 2 | 21 | 352.96 s |
| Worker `npm --prefix apps/worker test` (within Worker check) | 422 | 422 | 0 | 0 | 54.87 s |
| Local `pnpm run product:local:test` | 262 | 262 | 0 | 0 | 17.51 s |
| Browser `node --test apps/web/test/*.test.mjs` | 387 | 387 | 0 | 0 | Not retained |
| Worker `scripts:check` (main script phase) | 174 | 174 | 0 | 0 | 18.20 s |
| macOS source-only bundle checks | 55 | 52 | 0 | 3 | 2.21 s |

The Worker script gate also passed its 27 workspace-package checks. The full
`pnpm run test:macos:source` gate passed: in addition to the bundle phase above,
7 native/i18n checks and 18 preflight checks passed. Its three excluded tests
belong to the native artifact lane, not source qualification.

The full root run precedes the final native-copy, issue-template, and local
HTTP-harness follow-ups. Those changes received the owning source/script gates,
18 focused localization checks, and 12 documentation/API/guidance checks.
Documentation governance (115 Markdown files), architecture (366 production
files, 1439 imports, no debt edges), browser mirror, and whitespace checks pass.

The root reports 21 suite-declared skips; this change adds no skipped tests.
The two failures are the retained R7 receipt checks in
`test/r7-generated-release-evidence.test.js`: the changed runtime invalidates
`contractProvenance.workloadCodeSha256`, so the retained decision cannot be
rebuilt from those now-stale receipts. Focused rerun reproduces both. R7
regeneration is a separately authorized operation; no receipt or assertion was
rewritten to bypass that gate.

`product:worker:check` passed workspace, endpoint, type, script, and Worker
test phases, then correctly stopped at production asset staging because the
release tree is not clean and committed. Its overall exit is **not a pass**;
production/staging dry bundling remains unverified.

Rendered checks used an isolated loopback companion, empty analysis state,
read-only real Codex-folder detection, and disabled credential access. The
Community panel has no hosted-delete control. English, Spanish, and Simplified
Chinese disconnect copy renders; the no-device state disables confirmation;
Cancel and Escape restore focus to the opener. No horizontal overflow or
browser warning/error was observed. Successful disconnect, persistence,
reconnect gating, and failure receipts are covered by UI/local tests, not a
claim that the user's actual device was disconnected.

The revised public privacy page also rendered from the local Worker without
horizontal overflow or browser warnings/errors. Native fallback strings and
English/Spanish/Simplified-Chinese resource catalogs no longer point to the
retired hosted-privacy control; native rendering/install remains unqualified.

Local HTTP acceptance completed at `2026-08-31T00:57:07.885Z` (2026-08-30 in
the owner's timezone), using `lab:local --backend-only
--generated-content-free-fixture --port 18792 --companion-port 18791`:

- Participant deletion refusal preserved account state; owner authentication,
  CSRF, and ledger-proven retry checks passed.
- All 20 workload participants and the separate owner fixture were erased in
  the disposable lifecycle store. Participant/contribution/session/device
  counts and direct R2 object count were zero; 21 tombstones remained.
- No published weekly snapshot remained. One immutable empty suppression
  revision was withdrawn, preserving evidence rather than requiring it to stay
  in a current `suppressed` state.
- A separate retained 20-participant cohort plus its owner fixture survived a
  Worker restart; export/session checks and all 20 retained R2 objects passed.

Both task-started preview processes were stopped and their ports verified
closed. Private disposable lab state/receipts remain outside the repository
for inspection; no existing user account, data, or installed app was changed.

### Failures analyzed and fixes applied

- **Regression:** a cascaded D1 delete reports more than one changed row.
  Fenced finalization now checks the exact returned parent ID, not that count.
- **Concurrency defect found by independent code-quality review:** restore
  could steal an owner operation after its tombstone was written. Separate
  owner/restore fences and conditional finalization now have race/retry tests;
  the reviewer independently passed typechecking and 74 Worker tests.
- **Regression:** the new browser catalog import was absent from the local
  static asset map. The served module and exact native runtime graph now match.
- **Embedded-browser interaction:** Escape did not produce native dialog
  cancellation. A dialog-scoped key handler now preserves cancellation and
  opener focus; the regression failed before the fix and rendered checks pass.
- **Stale HTTP harness assertion:** successful daily public reads intentionally
  use `public, max-age=300`. The harness now pins that exact method/path/status
  exception and still requires `no-store` elsewhere, with no public cookies.
- **Stale terminal lifecycle assertion:** erasure withdraws suppressed as well
  as published snapshots. The check now proves the original suppression from
  the immutable empty payload and independently requires no published snapshot,
  no participant data, no R2 objects, and the exact tombstone count.

No flaky failure was identified in these checks. Full release validation still
needs attention because the protected evidence/bundling gates above remain.

### Integration follow-up — 2026-08-30

The owner subsequently requested commit, push, PR, merge, and task-local Git
cleanup. Implementation commit `da8e10d5` and integration commit `dccf5c5d`
were pushed to [PR #86](https://github.com/adamallcock/tibotattle/pull/86).
Integration includes main `1e696691` without conflicts. The PR remains **draft**;
merge and branch/worktree removal are pending validation, not completed.

Fresh checks on `dccf5c5d`:

| Check | Result |
| --- | --- |
| GitHub documentation, release-trust policy, and dependency scan | 3/3 passed |
| Full root `pnpm test` | 3147 total; 3123 passed; 3 failed; 21 existing skips; 469.06 s |
| Browser gate | 388/388 passed; 8.63 s |
| Local companion gate | 262/262 passed; 21.17 s |
| Complete Worker gate | Passed, including 422/422 Worker tests, 174/174 script tests, workspace/type/endpoint checks, and both dry-run bundles |
| Preflight and architecture | Passed; 115 Markdown files, 614 source/config files, 366 production files, 1439 imports, no debt edges |
| Isolated synthetic materialized-boundary retry | 2/2 passed; 11.69 s; does not replace the failed full-run result |

The two protected R7 freshness failures still identify stale source provenance.
The third full-run failure was `R7 materialized boundary isolated run stopped`
in `test/r7-materialized-boundary-benchmark.test.js`. Its isolated retry passed
without source or test changes, so this is explicitly **FLAKY**, not a clean
suite. The benchmark, harness, sampler, watchdog, and test are unchanged from
main. Concurrent test load was present, but the precise sampler/watchdog cause
is unresolved; no assertion, timeout, or guard was relaxed.

The first local-companion attempt was interrupted after the sandbox denied
loopback listeners (`EPERM`). The complete rerun with loopback access passed;
this is an environment restriction, not a source fix. The Worker dry-run gate
initially lacked its generated public-asset input. Building that input from the
committed source, the unchanged already-public social image, and explicit
unavailable-installer mode allowed the complete gate to pass. Those local
bundles do not qualify a signed installer or a production deployment.

Protected real-history R7 regeneration requires separate owner authorization,
which has been requested but not received. No retained R7 receipt was changed.
The release-coordination task was told to exclude this draft from the current
dogfood candidate. Full native/artifact qualification and the hosted cutover
below remain separate gates. Task-started blocked test processes were stopped;
unrelated worktrees and the primary checkout's two local commits were preserved.

## Deployment gate

Before a separately authorized production cutover, record aggregate counts of
active/deleting participants and existing tombstones, and identify how any
unfinished deletion will be completed through the owner procedure. Verify that
the owner can authenticate independently of the affected participant. Do not
delete old ledger entries or rewrite historical migrations. Deploy and verify
the Worker separately from releasing the desktop app; old installed apps may
still display their old button and must receive only a non-success response.

Resolve a private privacy-request intake/identity-verification procedure and
production retention/backup disclosures before cutover. Neither a support
issue form nor this technical owner endpoint establishes that process.
