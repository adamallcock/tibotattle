---
title: TiboTattle staging release verification
date: 2026-08-04
type: runbook
status: blocked-pending-owner-staging-and-production-reconciliation
---

# TiboTattle staging release verification

This runbook covers the read-only release-gate helper added in this worktree.
It validates the reviewed endpoint manifest, checks endpoint consumers for
source drift, and emits a content-free JSON receipt. It never deploys, invokes
Wrangler, writes R2/D1/Durable Objects, reads credentials, or changes an
installed app.

## Current boundary

The canonical manifest identifies `https://tibotattle.com` as the public
service and `https://updates.tibotattle.com/appcast.xml` as the Sparkle feed.
The release program expects a disabled, contained service. Fresh owner-provided
live evidence currently reports production `enrollmentMode=open`; therefore
production is uncontained and is not a staging or dogfood test target. The
helper must report that as deployment drift; it must not infer that production
is safe from the checked-in staging configuration.

The checked-in staging environment is separate and uses its own HTTPS
`workers.dev` origin. This helper intentionally does not accept an arbitrary
origin, so it cannot accidentally treat production as staging or probe an
unreviewed host.

## Read-only verification

Run the local check without network access:

```sh
node apps/worker/scripts/release-readiness.mjs
```

This validates the canonical manifest and all checked-in endpoint consumers.
Its receipt has `status: "public_unchecked"`; that is not live release proof.

Only an explicitly requested public check performs bounded, credential-free
GET requests to the canonical health, ready, and appcast URLs:

```sh
node apps/worker/scripts/release-readiness.mjs --probe-public --timeout-ms 5000
```

The live check expects `/api/health` to report `enrollmentMode: "disabled"`,
all four collection controls contained, and no external participant
authorization. An observed open/invite-enabled/otherwise inconsistent response
is recorded as fixed-code deployment drift. A structurally valid `503
not_ready` from `/api/ready` is retained as evidence but fails the live gate.
An explicit `404` (or `410`) from the appcast is recorded as
`APPCAST_NOT_PUBLISHED` and is always not-ready. Appcast XML is bounded and
only its byte count, digest, and structural counts enter the receipt; response
bodies and fetch errors never do.

The receipt is content-free and includes only fixed statuses/codes, public
manifest identifiers, hashes, bounded byte/count metadata, and
`collectionAuthorized: false`. No request sends an authorization header or
credential. No command option enables deployment or mutation.

Focused local tests:

```sh
node --check apps/worker/scripts/release-readiness-lib.mjs
node --check apps/worker/scripts/release-readiness.mjs
node --test apps/worker/scripts/release-readiness.check.mjs
```

## Owner-only staging follow-up

The following commands are documented for the release owner only. They were
not invoked by this verification lane. Review the exact origin and current
Cloudflare account state before running them; never substitute production for
the staging host.

1. Check the checked-in staging configuration and dry deployment:

   ```sh
   npm --prefix apps/worker run staging:check
   ```

2. After the owner has provisioned the isolated staging resources and confirmed
   that the preconditions are met, apply the disabled staging migrations and
   containment:

   ```sh
   npm --prefix apps/worker run staging:prepare -- \
     --confirm PREPARE_DISABLED_STAGING
   ```

3. Re-read staging readiness, then deploy only to the exact owner-confirmed
   staging origin:

   ```sh
   npm --prefix apps/worker run staging:deploy -- \
     --origin https://EXACT-STAGING-HOST \
     --confirm DEPLOY_DISABLED_STAGING
   ```

4. Re-run the owner-only live staging readiness check:

   ```sh
   npm --prefix apps/worker run staging:ready
   ```

These commands can inspect credentials or mutate remote state and remain
outside this lane's authorization. Their receipts must be reviewed separately;
the public production probe above cannot substitute for them.
