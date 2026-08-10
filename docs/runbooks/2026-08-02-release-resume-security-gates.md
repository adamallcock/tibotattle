---
title: TiboTattle Release Resume and Security Gates
date: 2026-08-02
type: runbook
status: historical-observation-current-source-unverified
---

# TiboTattle release resume — 2026-08-02

## State recorded on 2026-08-02

The 2026-08-02 live observation recorded a healthy Worker/D1 deployment, but it
predates later checked-in migrations and release controls. The checked-in
source now reaches primary migration `0029` and deletion-ledger migration
`0002`; the current production configuration keeps enrollment, account-scoped
ingest, and upload ingress disabled. This dated document does not prove that
those revisions or configuration are deployed. Until the owner reruns the
read-only production observer against the canonical endpoints and records a
fresh observation, the remote Worker/schema state is
unverified.

A verified, history-free client seed exists in a separate **private**
repository, but no consumer DMG, appcast, GitHub release, or public client
source has been published. Do not use a generic `wrangler deploy` against
production: the reviewed route is the migration-gated
`npm --prefix apps/worker run production:deploy -- --confirm
DEPLOY_PRODUCTION` (adding `--confirm-migrations` naming the exact pending
set when the checkout carries D1 migrations not yet applied to production),
which runs the local-only `release:preflight` gate, refuses a dirty checkout,
fails closed when the remote migration ledger cannot be read, and stages only
tracked web assets. The former owner-written containment receipt was retired
by the
[2026-08-07 governance decision](../governance/2026-08-07-production-deploy-migration-gate.md).
The deployment command is an execution path, not evidence about remote
state.

The 2026-08-02 observation found the update-feed infrastructure provisioned,
with an active TLS certificate and an empty bucket; the canonical appcast URL
returned the expected `404` at that time. This historical check does not prove
current feed, object, or guard readiness. Re-run the owner-only [Sparkle
publisher](./2026-08-02-r2-sparkle-update-publisher.md) and [release
execution](./2026-08-04-owner-release-execution.md) checks before calling the
channel configured or operational.

## Completed locally

- D1 contribution acceptance no longer performs a correlated per-row record
  count. Migration `0018` preserves the accepted-record count on write and the
  repository repairs only legacy null values.
- An authenticated, CSRF-protected `/admin` operations surface is present.
  It uses an identity-derived configured owner key, optimistic control
  revisions, auditable outcomes, bounded overview counts, sampled diagnostics,
  and a lease for maintenance.
- Hosted Apple and Google completion no longer stores or returns raw provider
  ID tokens. Callbacks verify the provider token, retain an irreversible link
  key and a short-lived opaque proof, and enrollment atomically consumes that
  proof.
- Production hosted-identity callbacks are pinned to
  `https://tibotattle.com`; `workers_dev` is disabled for the production
  environment.
- The macOS Node runtime retains only the two V8-required hardened-runtime
  exceptions. `disable-library-validation` is removed. Signed release output
  now requires a clean checkout at an annotated Git tag and records the tag
  and commit in the release manifest.
- The full Worker suite, macOS release suite, type checks, web-client suite,
  and a fresh local secret scan passed on 2026-08-02.

## Historical live verification on 2026-08-02

- `adamallcock/app-usagemonitor` is confirmed **private** on GitHub. The
  release branch `codex/release-security-client-split` is pushed through
  commit `f4f133e`.
- `adamallcock/tibotattle-client` is now confirmed **private** on GitHub. Its
  only commit is the history-free client seed
  `c912c52b6febcc1d7e433a822aec3a96f9977317`; it passed clean-client
  dependency install, client test, and macOS bundle test gates before upload.
  The one-way source-of-truth migration remains pending, so neither repository
  may yet produce a customer release.
- The `usage-monitor-notary` Keychain profile is usable: Apple returned recent
  accepted `TiboTattle.zip` submissions. It is no longer an external blocker.
- The R2 bucket `tibotattle-updates` now exists in `ENAM`; its public custom
  domain is `updates.tibotattle.com`. Ownership and TLS are active, the bucket
  is empty, and the canonical future feed URL is
  `https://updates.tibotattle.com/appcast.xml` (currently an expected `404`).
- At that time, remote D1 migrations `0017` through `0021` were applied.
  Worker version `1e61da66-dcca-4167-8f6c-ab1425116b8c` was live;
  `/api/health` and `/api/ready` both returned `200` after deployment. The
  checked-in source now includes primary migrations `0022` through `0029` and
  deletion-ledger migration `0002`, so this dated observation is not evidence
  that the current source, schema, or disabled containment posture is
  deployed.
- The supplied Google Web-client's exact production callback URI is registered
  in source and its secret was rotated directly into the Worker. The production
  secret list now contains the required envelope, identity, Apple, and Google
  secrets without exposing their values.
- `ADMIN_IDENTITY_LINK_KEY` remains intentionally absent. It is not a Worker
  deployment prerequisite: `/api/v1/admin/overview` returns the fail-closed
  `503 ADMIN_NOT_CONFIGURED` until the owner binds their actual pairwise
  identity-link key.
- Apple Service ID web registration is configured in the Apple portal with
  `tibotattle.com` and the canonical callback URL. Apple does not require a
  server association file for this registration; the historical
  `/.well-known/apple-developer-domain-association.txt` path intentionally
  returns `404` and is not a release gate.

## Required owner/configuration inputs

These are external-account actions or credentials. Do not replace them with
placeholders, and do not put the values in the repository.

The historical observations above are not current release authorization. For
the selected release channel, the owner must freshly receipt the exact
external Sparkle prerequisites: apply the nonce-ledger migration; bind
`SPARKLE_RELEASES` to the reviewed update bucket; set the fixed guard values
and the matching public verification key/fingerprint; store a fresh
owner-only `SPARKLE_APPCAST_GUARD_TOKEN`; and verify the HTTPS endpoint is
exactly the selected channel origin plus the fixed route. The owner must then
produce a signed/notarized DMG and complete the clean-profile signed `N` to
`N+1` rehearsal. The exact variable values and read-back requirements are in
the [Sparkle publisher runbook](./2026-08-02-r2-sparkle-update-publisher.md)
and [internal update rehearsal](./2026-08-04-internal-update-rehearsal.md).

1. To enable the owner-admin surface, set the production Worker secret
   `ADMIN_IDENTITY_LINK_KEY` to the
   64-character pairwise identity-link key for the intended active admin
   participant. It is deliberately separate from `IDENTITY_LINK_SECRET`; do
   not generate a placeholder. This does not affect ordinary user flow.
2. The bucket and custom-domain TLS are already provisioned; it contains no
   release object. Publish only through the reviewed update-feed publisher
   after the appcast is Sparkle-signed.

## Release sequence after those inputs exist

1. Review the complete diff, commit the intended release, and create an
   **annotated** version tag at that commit. The macOS release command rejects
   a dirty, lightweight-tagged, or untagged source tree.
2. From that clean tag, run the normal local verification and
   `npm --prefix apps/worker run production:deploy:dry`. Deploy the Worker
   separately only when a new reviewed service change requires it.
3. Run the localization gate: native and browser catalog parity, placeholder
   integrity, locale fallback/override tests, bundle resource inclusion, and
   a rendered English/`zh-Hans`/Spanish check of the language picker. Confirm
   that no language-selection path reloads the existing local dashboard or
   changes privacy, refresh, event-time, accounting, or provider-data
   behavior. Run the raw-data boundary, plural, RTL-fixture, and
   pseudo-localized expansion checks. Record the clean-profile packaged-AppKit
   system-language, text-expansion, and VoiceOver check separately if it is
   not performed by this release run, and do not claim human translation
   quality until native speakers review the privacy, deletion, security, and
   background-process copy.
4. Verify live `/api/health`, `/api/ready`, the exact custom-domain callback
   boundary, and a full Google/Apple sign-in completion without inspecting or
   logging provider tokens.
5. Build, Developer-ID sign, notarize, staple, and validate the macOS DMG from
   the tagged source. The release manifest must contain the matching commit
   and tag.
6. Complete the signed, `/Applications` Login Item lifecycle rehearsal below
   in a disposable profile and validate its receipt with
   `npm run product:macos:validate:login-item-release -- --app
   "/Applications/TiboTattle.app" --rehearsal RECEIPT.json`. This command runs
   only the packaged fake-manager smoke plus production artifact checks; it
   must not change the operator's real Login Items.
7. Publish the signed DMG and signed Sparkle appcast to the approved update
   destination, then independently verify the public HTTPS feed, artifact
   checksum, signature, and a clean-Mac update/install flow.

### Native Login Item rehearsal

Run this only in a disposable clean macOS user profile or release VM, never as
part of a source test on an operator's everyday account. On a first launch,
confirm that **Start TiboTattle at login** is visibly preselected yet no Login
Item exists before the person chooses **Get Started**. After that affirmative
action, inspect the Settings status, disable/unregister it, re-enable it, and
exercise the requires-approval/System Settings route if macOS presents one;
return to TiboTattle and confirm the Settings status reconciles. If approval
is pending, use **Remove Pending Login Item** and confirm the request is
withdrawn.

Sign out/in once to confirm automatic launch. Then test signed upgrade,
moving/reinstalling the app, uninstall/reinstall, and a second launch attempt;
each must leave one normal-app Login Item at most and explain an existing
companion rather than starting an overlap. Confirm that the only persistent
launch mechanism is TiboTattle's native `SMAppService.mainApp` registration:
there must be no LaunchAgent, LaunchDaemon, privileged helper, independent
process, raw-log scan, or background contribution/upload mechanism outside the
normal app lifecycle. Finally, close the main window and reopen it from the
menu bar, then use explicit Quit and confirm the companion stops.

Record the completed checks in a privacy-safe JSON receipt with this shape
(do not add user names, paths, account details, or raw logs):

```json
{
  "schemaVersion": "usage-monitor-macos-login-item-release-rehearsal-v1",
  "recordedOn": "YYYY-MM-DD",
  "environment": {
    "cleanDisposableProfile": true,
    "installedInApplications": true
  },
  "application": {
    "bundleIdentifier": "com.usagemonitor.local",
    "bundleVersion": "RELEASE_BUILD",
    "shortVersion": "RELEASE_VERSION"
  },
  "checks": {
    "firstRunConsentIsVisibleAndAffirmative": true,
    "settingsReconcileAfterSystemSettingsChange": true,
    "enableDisableAndPendingRemoval": true,
    "automaticLoginLaunch": true,
    "upgradeRetainsSingleMainAppLoginItem": true,
    "moveAndReinstallLeavesNoStaleDuplicate": true,
    "uninstallAndReinstallLeavesNoStaleDuplicate": true,
    "duplicateLaunchExplainsExistingApp": true,
    "windowCloseKeepsMenuBarAndQuitStopsApp": true,
    "noAgentDaemonOrBackgroundUpload": true
  }
}
```

## Explicitly not complete

- A fresh revision-bound deployment/schema observation (containment receipts
  were retired on 2026-08-07), owner admin-key
  binding (admin operations only), and current full Google/Apple callback
  completion against that deployment. The Apple association file remains
  intentionally unnecessary for the registered web flow.
- R2 appcast-guard provisioning, appcast publication, and DMG release,
  including signing/notarization and the clean-profile update rehearsal.
- Git tag, GitHub release, repository visibility change, client-service
  source-of-truth migration, branch/release-tag protection, and vulnerability
  reporting configuration.
