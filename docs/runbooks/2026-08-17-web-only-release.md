---
title: Web-only production release lane
date: 2026-08-17
type: runbook
status: maintained
---

# Web-only production release lane

Use this lane for a generated public-site change that must not carry a macOS
client, Worker-runtime, migration, dependency, or configuration change. It
reuses the already-published signed installer and does not create a client
version bump.

The lane is intentionally commit-bound. `product:web-release:prepare` refuses
a dirty candidate, requires the exact deployed source commit as its base, and
rejects a diff outside the approved public-site closure and release controls.
It generates the site through the normal generator, writes an ignored local
receipt, and does not push or deploy.

The public `release-site-manifest.json` carries hashes of the selected public
source closure but never a private Git SHA. The receipt at
`.release-build/web-release-receipt.json` records the candidate SHA locally;
the deploy command rechecks both before it delegates to the existing immutable
source-snapshot production guard.

## 1. Establish the source boundary

Find the full, 40-character Git commit recorded for the currently deployed
site from the prior deployment receipt or deployment log. Do not infer it from
the current branch, page contents, or a local generated directory. If the
deployed source commit cannot be established, stop and reconstruct that release
evidence before attempting a web-only deployment.

Create a clean, isolated candidate worktree from that commit. Apply only the
reviewed public-site changes, run the focused checks, and commit them. Do not
include a macOS app bump, Worker runtime change, migration, lockfile,
dependency update, or Wrangler configuration change.

`scripts/web-release-lane.js` permits these candidate paths only:

- Explicit public files under `apps/web/public/` that the release-site generator
  can serve.
- The generator, provenance/staging/deployment guards, their focused tests, and
  the release-lane runbooks.

It rejects every other path, including `apps/macos/`, Worker source/runtime
code, migrations, package-lock files, and deployment configuration. If
`package.json` appears in the candidate, the guard also requires every package
field and unrelated script to remain semantically unchanged; only the exact
release-lane script entries are allowed.

## 2. Reuse the existing installer evidence

The site builder still verifies the live HTTPS installer bytes against the
signed release manifest. Supply the already-published DMG and its matching
`.release.json` from the release archive; do not rebuild, sign, upload, tag, or
bump the macOS app. The social image must be an approved, absolute-path
1200×630 PNG outside `.release-build/public-release-site`.

```bash
DEPLOYED_SOURCE_COMMIT="<full deployed source SHA>"
RELEASED_DMG_PATH="/absolute/path/to/TiboTattle-X.Y.Z-macOS-arm64.dmg"
RELEASED_RELEASE_MANIFEST_PATH="${RELEASED_DMG_PATH}.release.json"
SOCIAL_IMAGE_PATH="/absolute/path/to/approved-1200x630.png"

npm run product:web-release:prepare -- \
  --base "$DEPLOYED_SOURCE_COMMIT" \
  --receipt "$PWD/.release-build/web-release-receipt.json" \
  --replace-receipt -- \
  --output "$PWD/.release-build/public-release-site" --replace \
  --site-url "https://tibotattle.com/" \
  --installer-path "$RELEASED_DMG_PATH" \
  --installer-release-manifest "$RELEASED_RELEASE_MANIFEST_PATH" \
  --installer-url "https://github.com/adamallcock/tibotattle/releases/download/vX.Y.Z/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --installer-version X.Y.Z \
  --installer-sha256 "<SHA-256 recorded in the signed release manifest>" \
  --minimum-macos 14.0 --architectures arm64 \
  --release-notes-url "https://tibotattle.com/docs.html" \
  --privacy-url "https://tibotattle.com/privacy.html" \
  --security-url "https://tibotattle.com/docs.html" \
  --support-url "https://tibotattle.com/docs.html" \
  --social-image "$SOCIAL_IMAGE_PATH"
```

The command writes the generated site and local receipt but makes no network
mutation. Keep both until post-deployment verification is complete. The
candidate must remain clean and at the same commit between preparation and
deployment.

## 3. Validate before asking for deployment authority

Run the focused checks from the candidate worktree:

```bash
npm run product:release-site:test
npm run product:web-release:test
node apps/worker/scripts/stage-production-assets.mjs
git diff --check
git status --porcelain=v1 --untracked-files=all
```

The final `git status` must print nothing; generated `.release-build` output is
ignored. Inspect the generated page with the normal local preview workflow and
confirm the installer version, download URL, canonical/social metadata, and
the changed public interaction. Do not treat a generated manifest from another
checkout or a previously built directory as evidence for this candidate.

## 4. Deploy only after explicit production authorization

This is the only web-only deploy entry point. It validates the receipt, repeat
checks the candidate scope, and invokes the production immutable-snapshot and
migration safeguards. It is still a Worker deployment, so it requires the
normal production credentials and explicit authorization.

The receipt's exact `baseCommit` is forwarded as the reviewed production
predecessor. Under the shared deployment lock, live health must still name that
base before Wrangler starts. A newer deployment makes this receipt stale: merge
the intended changes onto the new base and requalify, never auto-adopt live
source or bypass the guard. Interrupted outcomes use the production operation
journal and [explicit recovery procedure](production-operations.md#guarded-deployment-wrapper).

```bash
npm run product:web-release:deploy -- \
  --receipt "$PWD/.release-build/web-release-receipt.json" \
  --confirm DEPLOY_PRODUCTION
```

Never substitute a raw `wrangler deploy` command: it would bypass the
web-only receipt and source-scope checks. Record the successful source commit,
receipt digest, deploy time, and live smoke-check result as the next deployed
baseline.

## Rollback

Do not deploy an old checkout directly: the scope gate deliberately requires
the candidate to descend from the current deployed base. Instead, make a new,
clean revert commit on top of the current deployed web-only source that changes
only allowed public files. Prepare and authorize it through the same lane,
reusing the same released installer evidence unless an approved client release
also changes it.

This makes each web release and rollback a short, independently reviewable
commit. Other agents can prepare their own candidates in separate worktrees;
release one candidate at a time against the latest recorded deployed base.

## Reviewed Electron stable downloads

For a four-target normal Electron release, use the same public-site generator
with `--electron-publication-plan`, `--electron-publication-root`, and
`--electron-approved-plan-sha256`. These inputs exclude every native installer
argument. The digest is the maintained `identityDigest(plan)` of the separately
reviewed final stable publication plan; it is not the raw JSON file digest.
The artifact root contains the plan's relative local paths. Do not put either
input under the public source or inside the generated output.

The site intake consumes that approved plan independently of the website
checkout's package version. It verifies the stable origin, four targets, exact
installer names, and every bound local artifact/feed byte, then verifies each
public installer over HTTPS. It does not package, sign, notarize, publish feeds,
or reperform the separate native-trust/source review. The public site manifest
records only download metadata and verification scope, never the private plan
or its local paths. Native 0.1.18 generation remains unchanged.

Publish the exact canonical GitHub release assets before generating a production
site. Every manual download button uses the exact GitHub release URL, and the
site generator independently verifies its HTTPS bytes against the reviewed
plan digest and size. The updates.tibotattle.com origin is reserved for app
updater transport; never use its object URLs for manual website downloads.

The download section uses compact platform buttons, requirements, a discreet
checksum-copy control and accurate platform trust descriptions. It shows no
file size or migration procedure. Docs explains normal Mac replacement and
automatic retained-state transfer for 0.1.20 or later. Native Sparkle feeds do
not perform that move. Keep the Homebrew shortcut absent until the tap points
to a qualified automatic-replacement release, rather than the older native app.

A test-injected verifier may explicitly return `published: false` for a local
preview using the frozen local bytes. Such output displays a preview warning
and records `publishedInstallersVerified: false`; it is not a production
publication receipt. The ordinary CLI always uses real HTTPS verification.

The web-only scope admits the explicit Electron intake helper/test and the
canonical i18n file only for literal `electron.site.*` catalog entries; runtime
code or unrelated translations in that shared file still fail admission.
The generated mirror remains subject to the i18n mirror check. A local-preview
manifest is refused by the web-release receipt writer.

Electron mode uses an exact copy of the existing 1024×1024 public brand PNG
(outside the source/output roots) for `--social-image`. It verifies those bytes
against `tibotattle-icon.png` and emits square Open Graph dimensions, logo alt
text, and a summary Twitter card. Native generation retains its 1200×630 card.
This avoids presenting an older native-version screenshot as the Electron
release. Retained-state admission uses the app's schema compatibility check;
users do not need an intermediate native version or a preserved predecessor
executable. The 0.1.19 release cannot use these automatic-upgrade instructions.


The exact public evidence controls `config/release-evidence.js`,
`schemas/release-evidence-v1/manifest.schema.json`, the descriptor/policy/output
modules under `scripts/release-evidence-*.js`, and their owning test are admitted
for release evidence compatibility. These are tooling inputs, with no app,
Worker or package-runtime imports. This does not admit deployment configuration,
app/runtime source, other configuration files or unrelated schemas.
