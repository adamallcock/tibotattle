---
title: TiboTattle canonical production containment observer
date: 2026-08-04
type: runbook
status: production-containment-observer
---

# TiboTattle canonical production containment observer

This runbook covers the read-only canonical production containment observer
added in this worktree. It validates the reviewed production endpoint manifest,
checks endpoint consumers for source drift, and emits a content-free JSON
receipt. It never deploys, invokes Wrangler, writes R2/D1/Durable Objects,
reads credentials, or changes an installed app.

## Current boundary

The canonical production manifest identifies `https://tibotattle.com` as the
service and `https://updates.tibotattle.com/appcast.xml` as the Sparkle feed.
The observer expects production to be disabled and contained. Fresh
owner-provided live evidence currently reports production
`enrollmentMode=open`; therefore production is uncontained. The helper must
report that as deployment drift and must not identify itself as an internal
dogfood channel or infer safety from staging configuration.

The checked-in staging configuration describes a separate deployment shape,
but this observer has no live staging-origin input and makes no claim that a
real `workers.dev` staging deployment exists. It intentionally accepts only a
named channel from `config/release-channels.js`, so it cannot treat production
as dogfood or probe an unreviewed host. `stable` is the default and is bound to
the reviewed production deployment manifest. `internal-dogfood` is currently
owner-unconfigured and therefore reports a blocked, null-endpoint receipt
without falling back to stable.

## Read-only production observation

Run the local check without network access:

```sh
node apps/worker/scripts/release-readiness.mjs
```

This validates the canonical production manifest and all checked-in endpoint
consumers. Its receipt identifies `channel: "stable"`,
`observationChannel: "production_containment_observer"`, and has
`status: "public_unchecked"`; that is not live production evidence. Select a
different reviewed name only when it is present in the channel policy:

```sh
node apps/worker/scripts/release-readiness.mjs --channel internal-dogfood
```

An unconfigured channel fails closed and reports its configuration state and
null endpoints. No `--origin`, endpoint URL, or environment value can replace
the named policy.

Only an explicitly requested production observation performs bounded,
credential-free GET requests to the canonical health, ready, and appcast URLs:

```sh
node apps/worker/scripts/release-readiness.mjs --probe-public --timeout-ms 5000
```

The production observation expects `/api/health` to report
`enrollmentMode: "disabled"`, all four collection controls contained, and no
external participant authorization. An observed open/invite-enabled/otherwise
inconsistent response is recorded as fixed-code deployment drift. A
structurally valid `503 not_ready` from `/api/ready` is retained as evidence
but fails the observation. An explicit `404` (or `410`) from the appcast is
recorded as `APPCAST_NOT_PUBLISHED` and is always not-ready. Appcast XML is
bounded and only its byte count, digest, and structural counts enter the
receipt; response bodies and fetch errors never do.

The receipt is content-free and includes only fixed statuses/codes, the exact
selected channel policy and public manifest identifiers, hashes, bounded
byte/count metadata, and `collectionAuthorized: false`. A positive live result
uses `status: "remote_containment_observed"`; it is an operational observation
of the remote boundary, not a generic release-ready claim. The receipt records
`evidence.signedUpdate: "not_proven"` and
`evidence.nativeClientRehearsal: "not_run"` until a later native client
rehearsal independently proves those facts. No request sends an authorization
header or credential. No command option enables deployment or mutation.

Focused local tests:

```sh
node --check apps/worker/scripts/release-readiness-lib.mjs
node --check apps/worker/scripts/release-readiness.mjs
node --test apps/worker/scripts/release-readiness.check.mjs
```

## Owner-only staging follow-up

The following commands are a separate owner-only staging lane, not part of the
production containment observer. They were not invoked by this verification
lane. No staging origin is asserted here; the owner must review the exact host
and current Cloudflare account state before running them, and must never
substitute production for staging.

1. Check the checked-in staging configuration and dry deployment:

   ```sh
   npm --prefix apps/worker run staging:check
   ```

2. After the owner has provisioned the isolated staging resources and confirmed
   that the preconditions are met, deploy the compatible disabled Worker first:

   ```sh
   npm --prefix apps/worker run staging:deploy -- \
     --origin https://EXACT-STAGING-HOST-SUPPLIED-BY-OWNER \
     --phase pre_migration_compatibility \
     --identity-receipt-file /owner-only/staging-deployment-identity.json \
     --confirm DEPLOY_COMPATIBLE_DISABLED_STAGING
   ```

   This is the live deploy step. It does not manufacture a readiness receipt.
   The owner must observe the exact active revision and disabled/contained
   health, then create the local non-secret proof required by preparation.

3. Only after that proof is reviewed, apply the disabled staging migrations and
   containment:

   ```sh
   npm --prefix apps/worker run staging:prepare -- \
     --origin https://EXACT-STAGING-HOST-SUPPLIED-BY-OWNER \
     --receipt-file /owner-only/staging-disabled-worker-proof.json \
     --identity-receipt-file /owner-only/staging-deployment-identity.json \
     --confirm PREPARE_DISABLED_STAGING
   ```

4. Re-read staging readiness, then run the final contained deployment only to
   the exact owner-confirmed staging origin supplied by the owner:

   ```sh
   npm --prefix apps/worker run staging:deploy -- \
     --origin https://EXACT-STAGING-HOST-SUPPLIED-BY-OWNER \
     --confirm DEPLOY_DISABLED_STAGING
   ```

5. Re-run the owner-only live staging readiness check:

   ```sh
   npm --prefix apps/worker run staging:ready
   ```

These commands can inspect credentials or mutate remote state and remain
outside this lane's authorization. Their receipts must be reviewed separately;
the canonical production containment observation cannot substitute for them.
