---
title: Thousand-contributor calculator production publication
date: 2026-09-08
type: receipt
status: verified
source_commit: 32cd6317622c9aef9b7bf015b376b4cdb93c91fc
---

# Result and boundary

The owner-approved hosted calculator changes are deployed to production.
Public and authenticated admin graphs remain available while history continues
to be calculated. This proves the deployment and bounded observations below,
not completed historical backfill, a production throughput SLA or a desktop
release. The [production runbook](../runbooks/production-operations.md) remains
the operational authority. The
[local qualification](../reviews/2026-09-08-thousand-contributor-qualification.md)
records the 100/500/1,000-contributor workload, exact assertions and limits.

## Publication identity and gates

- Source: `32cd6317622c9aef9b7bf015b376b4cdb93c91fc`, published on
  `codex/scale-1000-contributors`; this operation did not merge into main.
- Deployment: `949daaea-948c-4da4-9f35-5b3493d1348e`, created
  2026-09-08 at 14:39:51 UTC.
- Worker version: `8258bfd0-5c19-4127-a23c-0f325f18044e`, serving 100%.
- Recovery bookmarks were obtained for both the primary database and deletion
  ledger before mutation. No restore was performed or claimed tested.
- Exactly migrations 0054–0056 were pending and explicitly approved. All three
  applied successfully; independent exact attribution and scale schema probes
  passed, and both migration ledgers then had no pending migrations.
- The normal `production:deploy -- --confirm DEPLOY_PRODUCTION` wrapper passed
  its immutable-source/dependency, local preflight, assets, pre-health,
  post-health and public-only checks. No emergency exception or deployment
  bypass was used.
- Independent health returned HTTP 200, `status: ok` and the exact deployed
  source. Database, deletion ledger, encrypted object storage and lifecycle
  checks passed. Existing collection controls remained operational.

## Live surface observations

At approximately 14:41 UTC, the public daily API returned HTTP 200 and confirmed
allowance data with 69 daily and 69 breakdown rows. The existing published
snapshot remained readable after migration and deployment. Browser inspection
confirmed the aggregate view and expanded model comparison, including Astra,
Sol, Terra, Luna and GPT-5.5; the model plot extends beyond the formerly stuck
seven-day segment. This does not imply every earlier date has a stable estimate.

The authenticated admin page rendered its graph and preparation panel without
an operations error. It showed 31 of 69 historical dates resolved, August 7 in
progress with 7 of 15 accounts complete, and 738 of 738 tracked source days
prepared. Its 11,609 saved checkpoint steps rendered correctly. These counts
describe different units; source preparation is not historical completion.

The admin also displayed a pre-existing GitHub distribution-sync warning from
13:41 UTC, before this deployment. Saved release counters remained available;
this external-source warning is not a calculator or database failure.

Independent crawler-style requests returned exact expected homepage and social
image bytes: HTTP 200, HTML and PNG MIME types, Open Graph/Twitter metadata,
and a 1200-by-630 image. Existing 0.1.18 installer links and Homebrew instructions
were retained; no new installer trust qualification is claimed.

## Natural scheduled refresh

A read-only, content-filtered log observation completed at 14:42:54 UTC. The
running maintenance pass reported `OK`, complete lifecycle and aggregate work.
Current analysis reported complete with zero accounts visited, published or
resumed. The unchanged daily lane used one query and processed zero days.
Historical August 7 advanced from the browser-observed 7 to 10 of 15 accounts,
using 572 phase queries in 35.581 seconds. Total optional work reached 617
queries and 40.047 seconds; history retained its incomplete checkpoint rather
than claiming a finished date. Two overlapping scheduled attempts correctly
reported `MAINTENANCE_IN_PROGRESS` without starting competing work. This is one
bounded production observation, not a sustained latency benchmark.

## Preserved boundaries

No telemetry was deleted or rewritten, no lease was cleared, no manual
maintenance was triggered and no live load test was run. Consent, retention,
v1.1 activation, desktop artifacts, release tags and update feeds were unchanged.
Normal scheduled work continues independently. Old code is not automatically
a safe rollback writer for the migrated prepared-work protocol; follow the
maintained recovery checks.
