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
generated Cloud Scheduler message docs. No `wrangler` command, deploy, push,
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
| Variant test: injected only, or absent, gives no update and a clean plan. Each of these gives exactly `scheduler:update:maintenance` and `EXECUTABLE:scheduler:update:maintenance`: another value, the documented App Engine default value, a lower-case or upper-case name, an extra header, a different header, `{}`, `null`, a non-string value, a body, and a body without headers. | `apps/worker/scripts/gcp-ops-infra-operations.check.mjs` |
| The staging pass-1/pass-2 rehearsal and both production rehearsals assert that the created triggers carry the injected header. They already asserted the post-apply plan is clean, and that assertion now runs against the realistic fake. | `gcp-ops-infra-staging-service.check.mjs`, `gcp-ops-infra-production.check.mjs` |
| Runbook notes: the API injects this header, readback accepts exactly it, and an update does not clear a stray header. | `docs/runbooks/gcp-staging-apply.md` section 8, `docs/runbooks/gcp-production-apply.md` section 6 |

## Why exactly this map

The installed SDK's generated `cloudscheduler_v1_messages.py` documents a
default `User-Agent` of `AppEngine-Google; (+http://code.google.com/appengine)`.
It also says the header "can be modified" and that the service appends to it.
That text does not match what the live API returned, and it does not say how
the stored map is cased. `gcloud scheduler jobs create http --help` says
nothing on the subject. The fix therefore pins only what was observed live:
one key, the case-exact name `User-Agent`, and the exact value
`Google-Cloud-Scheduler`.

A lower-case key is still an override. Nothing local shows that the API
normalizes stored header names, and accepting a variant nobody observed would
widen the readback contract without evidence. The documented App Engine value
is also an override, because it was not what the live API stored.

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

## Gates (local)

| Command | Result |
|---|---|
| `npm --prefix apps/worker run gcp:ops:infra:check` | 349 pass, 0 fail |
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
now state.
