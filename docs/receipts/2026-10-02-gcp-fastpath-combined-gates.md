---
title: GCP fast-path combined local gates
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP fast-path combined local gates

This is a 2026-10-02 receipt for the local gates on `claude/gcp-fastpath-final`
at `d4ea418d`. That commit holds the analytics fast path, the v1.0, v1.1 and
v1.2 intake ports, the thin edge and the deploy tooling fixes from the live
check. The gates ran serially in a clean worktree on one macOS arm64
workstation, against the local PostgreSQL 17 cluster on a private Unix socket.
Node 26.2.0 was the default, and Node 22.16.0 (the image runtime) ran where
noted. No GCP or Cloudflare call was made, and nothing was pushed. The branch
then fast-forwarded to `d386b8ae`. The commits after `d4ea418d` change
comments, docs and the offline address-probe tooling only. Their
`edge:e2e:check` passed 18 of 18, and `tsc --noEmit` exited 0.

The deployed evidence for the same commit is in the
[edge receipt](./2026-10-01-gcp-edge-proxy-local.md#redeploy-from-the-fixed-tooling-2026-10-02).

| Gate | Result |
|---|---|
| Worker `npx tsc --noEmit` | Exit 0 |
| PostgreSQL domain (`postgres:domain:check` halves, plus `PG_TEST_TCP_HOST`) | Exit 0. Vitest 76 of 76. node:test 335 pass, 2 skipped: the ledger-authority spec reads only `PG_TEST_HOST`, and passed 1 of 1 when run alone with it set; the Q-1 dump transfer case is opt-in |
| Worker `npm run scripts:check` | Exit 0, 1,053 pass, including `edge:e2e:check` and the dry run of all three edge modes |
| `cloud-run` `npm run check` | Exit 0 without the A2 activation variables: 286 tests, 285 pass, 1 skipped. With them set, exit 1 on one case (below) |
| `analytics-v2:check` and `vendor:kernels:check` | 108 of 108 and 10 of 10 |
| Worker `npx vitest run` | 2,363 of 2,364. The one failure is the known `test/storage-graph-history-integration.spec.ts` case (`effective_owner_pending` where `effective_checkpoint` is expected) |
| One-command rehearsal | `gate_failed` as expected: the per-date model-day difference only. The served body is 396,337 bytes, sha256 `a27aee71…`; the second refresh creates no revision |
| Edge end to end with the golden (Node 22.16.0) | 15 of 15, including S9's golden read and write tier |
| Root `architecture:check` and `test:preflight` | Pass |

## Known failure outside the fast path

`cloud-run/postgres-community-daily-activation.check.mjs` fails its opt-in
disposable-database case with "fresh migrations must match the exact
contained baseline". Primary 0050 closes `collection_controls.reason_code` to
the D1 vocabulary and makes it NOT NULL. Its starting row then carries
`initial`, so the fixture's update of a NULL reason matches no row. The A2
daily-activation tool writes `synthetic_daily_publication_test` and
`synthetic_v12_test_upload_only`, which 0050 refuses. That tool therefore
cannot run on a database migrated past 0050.

The gap dates from the INT-0 promotion, which moved the test's migration pin
from 46 to 58. The case is opt-in, so earlier gate runs skipped it. It fails
the same way at `7ef0e144`. The tool belongs to the legacy A2 test publisher
that `analytics-refresh` supersedes. The plan retires that publisher in its
own change, so this receipt records the gap and does not fix it.
