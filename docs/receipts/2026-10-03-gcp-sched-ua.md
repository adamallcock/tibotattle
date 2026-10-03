---
title: GCP scheduler injected User-Agent readback fix
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP scheduler injected User-Agent readback fix

This is a 2026-10-03 receipt for SCHED-UA on branch `claude/gcp-fp-sched-ua`,
cut from the fast-path final line at `b8864974`. It records **local,
synthetic** evidence only: one macOS arm64 workstation and Node 26.2.0. No
`gcloud` call ran except local `--help` output and the installed SDK's
generated Cloud Scheduler message docs
(`cloudscheduler_v1_messages.py`). No `wrangler` command, deploy, push,
remote read or live apply ran. Nothing is merged.

## The live finding it answers

After staging pass 2, the main session found that `plan --environment=staging`
still proposed `scheduler:update:maintenance`, and that `readback
--require-clean` exited 2 with `EXECUTABLE:scheduler:update:maintenance`. Every
field the planner manages matched on the live
`tibotattle-staging-maintenance-trigger`. Cloud Scheduler had also stored
`httpTarget.headers = {"User-Agent": "Google-Cloud-Scheduler"}`. The planner
never sets headers, but `schedulerView` counted any `headers` as an override.
An update could not converge because it passes no header flag, so the staging
migrate gate, which needs a clean readback, was blocked. The production
maintenance trigger would hit the same at production pass 2.

## What changed

| Item | Where |
|---|---|
| `SCHEDULER_INJECTED_HEADERS` (`{"User-Agent": "Google-Cloud-Scheduler"}`) and `schedulerHeadersInjectedOnly`. `overrides` is now `body !== undefined` or headers that are present and not exactly that map. | `apps/worker/scripts/gcp-ops-infra-operations.mjs` |
| The fake gcloud stores the observed header on `scheduler jobs create http`. An `update http` keeps the stored headers and body. Header and body flags are refused because the fake does not model them. | `apps/worker/scripts/fixtures/gcp-ops-infra/fake-gcloud.mjs` (`INJECTED_SCHEDULER_HEADERS`) |
| Variant test: injected only, or absent, gives no update and a clean plan. Each of these gives exactly `scheduler:update:maintenance` and `EXECUTABLE:scheduler:update:maintenance`: another value, the `AppEngineHttpTarget` default value (kept only as a negative variant), a lower-case or upper-case name, an extra header, a different header, `{}`, `null`, a non-string value, a body, and a body without headers. | `apps/worker/scripts/gcp-ops-infra-operations.check.mjs` |
| Stray-drift rehearsal: from a converged world, an extra header beside the injected one, or a body, is planned as `scheduler:update:maintenance` with no header or body flag. Applying it leaves the stray header or body stored, and the next plan still reports `EXECUTABLE:scheduler:update:maintenance`. The fake refuses `--headers`, `--update-headers`, `--remove-headers`, `--clear-headers` and `--message-body` with status 2. This binds the runbook warning to the fake's modelled update semantics. | `apps/worker/scripts/gcp-ops-infra-operations.check.mjs` |
| The staging pass-1/pass-2 rehearsal and both production rehearsals assert that the created triggers carry the injected header. They already asserted the post-apply plan is clean, and that assertion now runs against the realistic fake. | `gcp-ops-infra-staging-service.check.mjs`, `gcp-ops-infra-production.check.mjs` |
| Runbook notes: the API injects this header, readback accepts exactly it, and an update does not clear a stray header. | `docs/runbooks/gcp-staging-apply.md` section 8, `docs/runbooks/gcp-production-apply.md` section 6 |

## Why exactly this map

Two sources agree on the value. The live staging readback stored
`{"User-Agent": "Google-Cloud-Scheduler"}`. The installed SDK's generated
`cloudscheduler_v1_messages.py` documents `HttpTarget.headers`, the target
type the planner builds, and says that `User-Agent` "will be set to
`Google-Cloud-Scheduler`" (class `HttpTarget`, around lines 510, 536 and 601).
The `AppEngine-Google; (+http://code.google.com/appengine)` default in the same
file belongs to class `AppEngineHttpTarget`, which the planner never uses. The
variant test keeps that value only as a negative case. `gcloud scheduler jobs
create http --help` says nothing on the subject.

The SDK text describes the header sent on the job's request. It does not say
that the header is stored in the job's `headers` map, which only the live
readback shows. Neither source settles whether stored header names are
normalised for case. The fix therefore pins exactly what was observed live:
one key, the case-exact name `User-Agent`, and the exact value
`Google-Cloud-Scheduler`.

A lower-case or upper-case key is still an override. Nothing local shows that
the API normalises stored header names, and accepting a variant nobody
observed would widen the readback contract without evidence.

## Mutation check

Each mutation was applied to `gcp-ops-infra-operations.mjs`, run against the
operations, staging-service and production checks (56 tests), and then
reverted:

| Mutation | Result |
|---|---|
| The original `headers !== undefined` rule | 22 failures, including the staging rehearsal and both production rehearsals with `EXECUTABLE:scheduler:update:maintenance`, the live symptom |
| Ignore a body | 1 failure (variant test) |
| Check only the `User-Agent` value, so extra headers pass | 1 failure |
| Case-insensitive name | 1 failure |
| Any `User-Agent` value | 1 failure |
| `{}` accepted | 1 failure |
| `null` accepted | 1 failure |
| Restored | 56 pass, 0 fail |

A review then found that no test bound the fake's `update http` semantics,
which back the runbook warning that the planned update cannot clear a stray
header. After the stray-drift rehearsal was added, each mutation below was
applied to `fake-gcloud.mjs`, run against every file in
`gcp:ops:infra:check` plus `gcp-production-rollout.check.mjs` (378 tests),
and then reverted:

| Mutation | Result |
|---|---|
| `update http` drops the stored headers and body | 1 failure (stray-drift rehearsal) |
| `update http` re-injects only the `User-Agent` header, wiping a stray header | 1 failure (stray-drift rehearsal) |
| The refusal of header and body flags is removed | 1 failure (stray-drift rehearsal) |
| Restored | 378 pass, 0 fail |

## Gates (local)

| Command | Result |
|---|---|
| `npm --prefix apps/worker run gcp:ops:infra:check` | 350 pass, 0 fail |
| `node --test apps/worker/scripts/gcp-ops-infra-staging-service.check.mjs` | 12 pass, 0 fail |
| `npm --prefix apps/worker run gcp:production-rollout:check` | 28 pass, 0 fail |
| `npm run test:preflight` | exit 0 |
| `npm run architecture:check` | exit 0 (963 production files, 0 debt edges) |

## What this does not prove

This is in-memory evidence. The live staging readback must be rerun with this
code to show `--require-clean` exits 0. The production maintenance trigger is
not created yet. If a live trigger ever carries a genuine override header, the
planned update cannot remove it, because the update passes no `--clear-headers`
or `--remove-headers`. That case remains a manual repair, which the runbooks
now state. The stray-drift rehearsal proves this only against the fake's
modelled `update http`, which keeps stored headers and body when no header or
body flag is given. It does not prove live `gcloud` behaviour.
