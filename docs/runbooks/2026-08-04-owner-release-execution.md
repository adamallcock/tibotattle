---
title: TiboTattle owner release execution
date: 2026-08-04
type: runbook
status: owner-executable-fail-closed
---

# TiboTattle owner release execution

This is the release sequence for an owner operating from a clean, reviewed
checkout. It separates local proof, deployment inspection, owner-only external
activation, and observed client acceptance. This sidecar has performed none of
the external actions below.

## Current posture and evidence vocabulary

At this checkout:

- `apps/worker/wrangler.jsonc` names separate staging resources and keeps
  staging enrollment, account-scoped ingest, and queue ingest disabled. The
  checked-in production vars are also disabled, but live production is treated
  as **uncontained** until a fresh owner probe proves otherwise.
- `config/release-channels.js` has a stable descriptor and an
  `internal-dogfood` descriptor whose endpoints, bucket, object prefix, and
  public-key fingerprint are all `null`. Resolving or publishing that channel
  must fail with `RELEASE_CHANNEL_NOT_CONFIGURED`. Do not invent a host, feed,
  bucket, key, or beta channel, and never copy stable values into dogfood.
- `config/deployment-endpoints.js` records identifiers for the stable service
  and appcast. Those identifiers are not proof that the service or appcast is
  available. Treat the stable appcast as unavailable until a real owner action
  verifies the exact feed and artifact.

Use these meanings in every receipt and handoff:

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| Local code/test proof | Checked-out contracts, tests, and a local/package boundary | Remote deployment, signing, feed availability, or installed-app behavior |
| Deployment configuration inspection | Reviewed identifiers and fail-closed settings in source/config | Resource existence, applied migrations, live containment, or public intake safety |
| Owner activation receipt | The exact owner-authorized remote mutation and its bounded post-check | A native updater downloading or installing anything |
| Observed `N → N+1` acceptance | A signed app actually survives cancel, retry, install, relaunch, and rollback handling in a disposable profile | Authorization to open public intake without the remaining gates |

Receipts must be content-free: record revision/tag, channel, version, bounded
statuses, artifact byte count/digest, and pass/fail. Never record private keys,
Keychain exports, provider tokens, OAuth codes/verifiers, account identifiers,
raw appcast/artifact bytes, or raw logs.

## Strict sequence

Do not advance on a failed or merely unavailable gate. The only valid order is:

`development → isolated disabled staging → signed internal dogfood → closed beta → public stable`

### 1. Development: local code and test proof

Run the existing local gates from the candidate checkout:

```sh
npm test
npm run product:check
npm run docs:links:check
npm run product:macos:build
npm run product:macos:validate:development
```

The evidence must include the source revision and green results for the Worker,
web, macOS, architecture, asset, and local-review checks covered by
`product:check`. The identity tests must cover both Google and Apple state/
nonce/PKCE boundaries, expiry and replay rejection, single-use completion, and
cancelled-flow cleanup. A live provider login is not substituted with test
fixtures, and a green local suite is not called a deployed proof.

**Gate / rollback.** Stop on any test failure, unexpected network or data
boundary, updater-channel mismatch, or packaged-app failure. Keep intake closed;
reject the candidate and return to the last passing source revision/build.

### 2. Isolated disabled staging: inspect, then owner activates only the exact target

First inspect checked-in configuration; this is static evidence only:

```sh
npm --prefix apps/worker run staging:check
node apps/worker/scripts/release-readiness.mjs
```

The staging result must remain a safe/unprovisioned or otherwise explicitly
reviewed disabled result with `liveProof: false`. The production observer's
`public_unchecked` result is also local evidence, not live production proof.

Only after the owner has independently identified and reviewed the exact,
non-production staging origin and resources may the owner run the mutating lane:

```sh
npm --prefix apps/worker run staging:prepare -- \
  --confirm PREPARE_DISABLED_STAGING
npm --prefix apps/worker run staging:deploy -- \
  --origin https://EXACT-STAGING-HOST-SUPPLIED-BY-OWNER \
  --confirm DEPLOY_DISABLED_STAGING
npm --prefix apps/worker run staging:ready
```

The final receipt must show the exact staging resources, current checked-in
migration sequence, lifecycle readiness, `ENROLLMENT_MODE=disabled`, all
collection controls contained, and `collectionAuthorized: false`. A
`workers.dev` hostname appearing in output is not by itself proof that it is
the reviewed staging target. Never substitute the production custom domain.

**Gate / rollback.** Any missing resource, migration drift, origin mismatch,
redirect, readiness failure, open/invite-enabled health, or non-contained
control stops the sequence. Do not issue invitations or upload data. Preserve
the receipt and use the disabled-staging recovery procedure; do not use generic
Wrangler commands or delete/recreate resources. The detailed boundary is in
[`disabled staging readiness`](./2026-08-04-disabled-staging-readiness-boundary.md).

### 3. Signed internal dogfood: dedicated channel plus real client rehearsal

This stage is blocked in the current checkout until an owner-reviewed
`internal-dogfood` policy is committed. That policy must provide distinct,
non-production service and website origins, a distinct Sparkle origin/appcast,
bucket and immutable object prefix, and a distinct reviewed Ed25519 public-key
fingerprint. The current expected result is
`RELEASE_CHANNEL_NOT_CONFIGURED`; a placeholder or copied stable policy is a
hard stop.

After that policy and its tests are reviewed, the owner creates the candidate
from an annotated tag and runs the existing external-distribution/release path
described in [`the macOS release guide`](../../apps/macos/README.md). The
release command must name the channel explicitly; the current package script
therefore needs the extra argument:

```sh
npm run product:macos:updater:prepare
npm run product:macos:release -- --channel internal-dogfood
```

The signed release gate must prove a clean checkout, an annotated tag at
`HEAD`, reproducibility from checked-out source, Developer ID/hardened-runtime
assurances, notarization/stapling, Gatekeeper, and clean-profile checks. The
release manifest must bind the artifact to `internal-dogfood`; it must not be
called stable. Do not use `validate-macos-install.js` directly for this stage:
its CLI has no channel option and defaults to stable. The channel-aware release
gate and publisher validation are the valid dogfood artifact checks.

The owner signs the exact DMG with the offline Sparkle process, then runs the
publisher validation-only path with `--channel internal-dogfood`, the exact
owner-reviewed dogfood bucket, appcast file, release manifest, DMG, and public
verification key. Only after reviewing that local plan may the owner add
`--publish` (and `--replace-appcast` only when the existing feed is present and
the candidate version is strictly newer). The publisher's public read-back
must prove the exact appcast bytes, headers, current enclosure, and DMG bytes /
digest.

The current publisher publishes a **full candidate DMG**. It may retain an
older full or delta enclosure only after reading its existing immutable object
and verifying its advertised length, SHA-256, and Ed25519 signature. It does
not upload a new delta. A new delta requires a separately implemented,
atomic publication path and a fresh rehearsal; do not imply one exists.

**Gate / rollback.** Missing dogfood configuration, a feed 404/410, redirect,
malformed or mismatched enclosure, missing/mismatched immutable object,
signature failure, failed public read-back, or a dirty/untagged release stops
the stage. Publication is not automatically reversible: immutable objects may
remain and the feed pointer may be changed without rollback. Do not delete
objects. Keep the previous signed `N` DMG and manifest for manual recovery;
leave public stable closed and fix forward with a strictly newer candidate if
the feed pointer has advanced. The publisher details are in
[`the Sparkle publisher runbook`](./2026-08-02-r2-sparkle-update-publisher.md).

Now perform the owner-only disposable-profile rehearsal in
[`the internal update rehearsal`](./2026-08-04-internal-update-rehearsal.md):

1. Install signed `N`, establish a harmless local-state canary, and retain a
   recoverable copy of `N`.
2. Preflight the exact dogfood feed/artifact with bounded read-only HTTPS
   evidence. An unavailable feed blocks the attempt; central health alone is
   insufficient.
3. From `N`, start the updater and cancel while cancellable. Confirm the app
   remains `N`, no update is reported installed, and the flow can be retried.
4. Retry and observe download, verification, install-on-quit/relaunch, `N+1`,
   canary retention, one app identity, and no duplicate update operation.
5. Exercise the OAuth flow in the installed build with an owner-approved test
   account: complete Google and Apple once without recording tokens, then
   cancel each flow and confirm only that state is terminal, polling stops, a
   fresh state can start, and stale/replayed state is rejected.
6. If any step fails, quit the candidate, restore signed `N`, confirm normal
   `N` behavior and the canary, and retain the failed content-free receipt.

Only this observed cancel/retry/relaunch result is updater acceptance. Remote
appcast/R2 read-back is **not** native client acceptance.

### 4. Closed beta: invite-only, owner-controlled intake

Do not treat the current staging pilot commands as production commands; their
confirmations and deployment target are explicitly staging. A closed beta
needs a separately reviewed owner procedure for the exact beta service and
invitation policy. The checked-in runtime supports `invite_only`, but this
checkout does not configure a production beta endpoint or a second updater
channel. If the owner cannot identify both exact reviewed boundaries, stop.

Before any beta intake, the owner must run the read-only production observer:

```sh
node apps/worker/scripts/release-readiness.mjs \
  --probe-public --timeout-ms 5000
```

Require fresh health/readiness evidence for the canonical production service:
enrollment disabled, all collection controls contained, no external
participants authorized, and no unexpected redirect. This is the containment
fence. The current live posture is uncontained until this owner action proves
otherwise, regardless of checked-in vars or staging receipts.

Only after that fence is recorded may the owner use the separately reviewed
production activation procedure: deploy the reviewed `invite_only` beta
configuration through `npm --prefix apps/worker run production:deploy` (never a
generic `wrangler deploy`), issue only reviewed one-use invitations, and verify
the exact live beta health/readiness and control receipt. The beta must remain
non-public, publication-disabled, rate-bounded, and limited to the approved
cohort. Do not put invitation secrets or OAuth material in receipts.

**Gate / rollback.** Any open enrollment, uncontained control, public
publication, unexpected participant, OAuth state/cancel failure, lifecycle
failure, or cohort expansion pauses the beta immediately. Use the owner's
reviewed production containment path, then restore the reviewed disabled
configuration with the existing `production:deploy` path and re-run the
containment observer. Do not improvise a production SQL or Wrangler command.
No public intake gate may inherit a passing staging or dogfood receipt.

### 5. Public stable: publish, observe, then open intake

Public stable requires all earlier receipts, a fresh containment receipt, a
successful OAuth completion/cancel test in the shipped candidate, and a
successful `N → N+1` rehearsal. Build from a clean annotated tag using the
stable channel explicitly:

```sh
npm run product:macos:updater:prepare
npm run product:macos:release -- --channel stable
npm run product:macos:validate:release
```

Retain the previous signed/notarized DMG and manifest, and run the existing
replacement validator before replacing a shipped candidate:

```sh
node scripts/validate-macos-replacement.js \
  --previous "/path/to/previous.dmg.release.json" \
  --candidate "/path/to/candidate.dmg.release.json"
```

Before comparing versions, the replacement gate requires valid named-channel
provenance on both manifests and requires the previous `N` and candidate `N+1`
names to match exactly. A stable manifest cannot replace an internal-dogfood
manifest, and neither may omit channel provenance. The provenance must also
match the selected policy's service mode, endpoints, updater feed, bucket,
object prefix, and public-key input; its Sparkle public-key fingerprint must
match the updater fingerprint sealed in that same manifest. The previous `N`
and candidate `N+1` updater fingerprints must then match exactly, even though
stable intentionally has no statically configured fingerprint. Otherwise stop
the release.

The owner signs the exact stable DMG and validates the appcast locally with
the complete existing publisher command, including `--channel stable`, using
only the reviewed stable bucket, release manifest, appcast, DMG, and public
key. The first publication must not be forced with `--replace-appcast`; later
replacement requires that flag and a strictly higher bundle version. Add
`--publish` only for the explicit owner activation. Treat any feed 404/410,
redirect, signature/digest/length mismatch, or public read-back failure as not
published.

Before the first owner publication, complete the guard provisioning checklist
in [`the R2 Sparkle publisher runbook`](./2026-08-02-r2-sparkle-update-publisher.md)
and retain a content-free receipt for the exact stable channel, binding, route,
configuration checks, nonce-ledger migration, and post-provisioning conflict
probe. The CLI must receive both explicit
`--atomic-appcast-guard-endpoint` and
`--atomic-appcast-guard-token-env SPARKLE_APPCAST_GUARD_TOKEN` options; the
token is supplied through that allowlisted environment variable name, never as
a literal CLI argument. The publisher scrubs the variable before spawning
Wrangler. There is no stable endpoint default. Validation-only runs remain
usable without either option and must not contact the guard or R2.

Before opening any broader intake, rehearse signed `N` followed by signed `N+1`
in a disposable environment with the exact previous-manifest continuity input.
The rehearsal must include one successful guarded appcast CAS, a deliberate
stale-current conflict with no second appcast mutation, a retry with a fresh
nonce, and the normal Sparkle cancel/retry/install-on-quit/relaunch flow.
Preserve only content-free statuses, byte counts, and SHA-256 values; do not
retain tokens, raw signed XML, or raw logs. A passing local test or remote
appcast read-back does not prove this owner-only rehearsal occurred.

After the publisher succeeds, independently retain its content-free
publication receipt and complete the same disposable `N → N+1` rehearsal
against the stable feed. The feed and artifact read-back still do not replace
the native cancel/retry/relaunch observation.

Only after that acceptance may the owner open public intake through the
reviewed production activation procedure and immediately re-check live health,
readiness, enrollment mode, collection controls, and public website/app
metadata. A public page, a healthy service, a stored signing profile, or a
published appcast alone is not this gate.

**Gate / rollback.** On any post-publication defect, stop intake and contain
production first; keep the previous signed DMG available for manual
installation. Do not delete immutable update objects and do not publish an
equal/lower version to simulate rollback—the current publisher rejects that
and has no automatic feed-pointer rollback. Restore the previous client
manually where needed, preserve the failed receipt, and release a strictly
newer corrected candidate only after the full sequence is re-run.

## Universal stop rules

Stop and hand back to the owner when any of these is true: the checkout is
dirty or the release tag is not annotated; a channel resolves to an unknown or
unconfigured policy; a staging or beta target is not exact and non-production;
live containment is absent; the stable appcast or artifact is unavailable;
OAuth state, nonce, PKCE, expiry, replay, or cancel behavior is not observed;
the installed app identity/version is unexpected; a receipt would contain
secrets or raw user/provider data; or rollback to the retained signed `N` is
not possible. Do not advance by inference, by a local preview, by remote
appcast read-back, or by a health response alone.
