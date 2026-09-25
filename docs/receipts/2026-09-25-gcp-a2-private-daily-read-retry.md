---
title: GCP A2 private daily read retry
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 private daily read retry

This receipt records the approved synthetic retry completed on 2026-09-25 in
GCP project `tibotattle`, region `us-east1`. It proves one successful IAM
private read of a synthetic daily aggregate in the test environment. It does
not prove production cutover or Cloudflare migration.

## Tested artifact and prewrite state

The test used Cloud SQL primary `tibotattle-test-primary-20260922`, database
`tibotattle`, schema `tibotattle_v12_a2_20260925`, day `2026-09-25`, and source
`synthetic-community-source` / `synthetic-community-namespace`. Successful
prewrite backup `1790367493471` was confirmed.

Cloud Build `a2108f42-0fc5-4f94-ad84-089ed4161a18` built image
`sha256:ba8d37c599eb587ea98d081423ad86ca0d04c58cfb096f4fdcd0607770d83833`
from source digest
`3c466e0df2bc7435b248567dadc1e5d31519078e4ef4f87a700499a4d60ac52a`. At the
private read, the service and daily Jobs used this image. The tested m44 source
is committed as `8c8eead6f9d7bc4269f0f59ff94e9b080015122c` on isolated
branch `codex/gcp-a2-daily-retry-20260925`; its build-context digest matches
the image source digest above. This documentation worktree is at m41 and the
m44 branch has not been merged into it.

## Execution and result

- Prepare execution `xsn72` advanced collection controls from revision 4 to 5
  without inserting another fixture; retained aggregate revision 1 was intact.
- Publisher execution `qcx27` appended immutable aggregate revision 2 for the
  same synthetic day and source: `usageEvents: 1`,
  `collection_revision=5`, `policy_revision=1`,
  `allowanceState=updating`, and the v1/v1.1-only projection scope.
- At `2026-09-25T20:28:59.294315Z`, authenticated private GET was served by
  revision `tibotattle-test-app-00044-ktp` and returned HTTP 200 for the exact
  requested day and revision 2. Readback matched the publisher receipt; the
  response used no-store protections and contained no source ID or namespace.
- Restore execution `lrkl6` advanced controls to revision 6, with publication
  and enrollment off. Independent read-only probe `tmdqj` found exactly the two
  immutable rows: revision 1 at collection revision 3 and revision 2 at
  collection revision 5. Both had policy revision 1; source authority epoch and
  cursor sequence remained zero. The probe confirmed revision 6 and publication
  off.

## Restored service state and limits

After the successful read, another image deployment created service revision
`00045`. Revision `00046-64g` restored
`canonical-v1-primary` / `telemetry-v1` while preserving the newer image.
IAM remained private: anonymous `/api/health` returned 403 and authenticated
`/api/health` returned 200. Post-test health reported primary migration 44/44
and independent ledger migration 6/6. The maintenance Scheduler remained
paused, and all three daily Jobs were restored to their pre-retry image and
arguments, including publisher preflight mode.

The fixture and both aggregate revisions remain in the test schema. This was a
single synthetic read journey, not a load or production test. Production
Cloudflare and its data were not changed.
