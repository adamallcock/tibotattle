---
title: TiboTattle Release Resume and Security Gates
date: 2026-08-02
type: runbook
status: release-infrastructure-partially-provisioned
---

# TiboTattle release resume — 2026-08-02

## Current release state

The source tree contains the locally validated release work, but it is **not
approved to deploy or publish yet**. Do not use a generic `wrangler deploy`
against production: the reviewed route is `npm --prefix apps/worker run
production:deploy`, which refuses a dirty checkout and stages only tracked
web assets.

No source deployment, tag, GitHub release, DMG, or appcast has been published
as part of this recovery. The update-feed infrastructure is now provisioned,
its TLS certificate is active, and its bucket remains empty.

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

## Live verification on 2026-08-02

- `adamallcock/app-usagemonitor` is confirmed **private** on GitHub. The
  release branch must be pushed there before any public-source split is made.
- The `usage-monitor-notary` Keychain profile is usable: Apple returned recent
  accepted `TiboTattle.zip` submissions. It is no longer an external blocker.
- The R2 bucket `tibotattle-updates` now exists in `ENAM`; its public custom
  domain is `updates.tibotattle.com`. Ownership and TLS are active, the bucket
  is empty, and the canonical future feed URL is
  `https://updates.tibotattle.com/appcast.xml` (currently an expected `404`).
- The production Worker has the envelope keys, `IDENTITY_LINK_SECRET`, Apple
  private key, and a Google client secret, but **does not** yet have
  `ADMIN_IDENTITY_LINK_KEY`.
- The supplied Google Web-client file contains the exact production callback
  URI, but its client ID differs from the client ID presently committed in the
  production Worker configuration. The source must be updated and the Worker
  secret rotated as one release operation; do not leave a new client ID paired
  with an old client secret.
- Remote D1 reports migrations `0017` through `0021` pending. They must be
  applied before serving the new identity/admin functionality.
- `https://tibotattle.com/.well-known/apple-developer-domain-association.txt`
  currently returns `404`; Apple sign-in remains disabled until the exact
  association text and Apple callback registration are supplied and verified.

## Required owner/configuration inputs

These are external-account actions or credentials. Do not replace them with
placeholders, and do not put the values in the repository.

1. Set the production Worker secret `ADMIN_IDENTITY_LINK_KEY` to the
   64-character pairwise identity-link key for the intended active admin
   participant. It is deliberately separate from `IDENTITY_LINK_SECRET`.
2. In the same planned release window, deploy the reviewed source with the
   supplied Google Web-client ID and rotate `GOOGLE_OIDC_CLIENT_SECRET` from
   the supplied local file. Confirm all other required production secrets are
   installed, including envelope keys, `IDENTITY_LINK_SECRET`, and Apple
   private key. Apply migrations only through the reviewed production
   deployment process.
3. In Google Cloud Console, register only
   `https://tibotattle.com/api/v1/identity/google/callback` as the production
   redirect URI. The Worker will reject a Workers.dev or `www` callback host.
4. Provide the exact Apple domain-association text as the production
   `APPLE_DOMAIN_ASSOCIATION` configuration and register the same
   `tibotattle.com` callback URL with Apple.
5. The bucket and custom-domain TLS are already provisioned; it contains no
   release object. Publish only through the reviewed update-feed publisher
   after the appcast is Sparkle-signed.

## Release sequence after those inputs exist

1. Review the complete diff, commit the intended release, and create an
   **annotated** version tag at that commit. The macOS release command rejects
   a dirty, lightweight-tagged, or untagged source tree.
2. From that clean tag, run the normal local verification plus
   `npm --prefix apps/worker run production:deploy:dry`. Then deploy the
   Worker via `npm --prefix apps/worker run production:deploy` only when
   production migration and secret checks are satisfied.
3. Verify live `/api/health`, `/api/ready`, the exact custom-domain callback
   boundary, the Apple domain-association response, and a full Google/Apple
   sign-in completion without inspecting or logging provider tokens.
4. Build, Developer-ID sign, notarize, staple, and validate the macOS DMG from
   the tagged source. The release manifest must contain the matching commit
   and tag.
5. Publish the signed DMG and signed Sparkle appcast to the approved update
   destination, then independently verify the public HTTPS feed, artifact
   checksum, signature, and a clean-Mac update/install flow.

## Explicitly not complete

- Production deployment and D1 migration application.
- Owner admin-key binding, Google client-ID/secret rotation, Apple console
  configuration, and the Apple association file.
- R2 appcast publication and DMG release.
- Git tag, GitHub release, push, or repository visibility change.
